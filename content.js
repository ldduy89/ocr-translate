(() => {
  // The script is injected once per page. After the extension is reloaded, the old copy is still in the page but its
  // chrome API is gone (chrome.runtime.id is undefined): remove its UI and start again, so the new version shows its buttons.
  if (window.__ocrTranslateInjected) {
    if (chrome.runtime && chrome.runtime.id) return; // the current copy is already running
    for (const id of ['ocr-dock-host', 'ocr-pill-host', 'ocr-page-panel-host', 'ocr-toast', 'ocr-panel', 'ocr-confirm-host']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    document.querySelectorAll('.ocr-img-overlay').forEach((n) => n.remove());
  }
  window.__ocrTranslateInjected = true;

  let panel = null;

  // Remember the image that was just right-clicked, so the translation is overlaid on the correct <img> tag
  let lastContextImg = null;
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    lastContextImg = t instanceof Element ? (t.closest('img') || null) : null;
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'LIST_IMAGES':     listPageImages().then(sendResponse); return true;
      case 'SHOW_LOADING':    showToast('Đang nhận dạng và dịch...', 'info', TOAST_MS); break;
      case 'SHOW_ERROR':      showToast('⚠ ' + msg.error, 'error', TOAST_MS); refreshPill(); break;
      case 'HIDE_PANEL':      removePanel(); hideToast(); break;
      case 'QUEUE_CLEAR':     queuedKeys.clear(); refreshPill(); break;
      case 'OVERLAY_IMAGE':   overlayImage(msg); break;
      case 'TRANSLATE_ALL_START': collectAndTranslateAll(msg.urls); break;
      case 'SHOW_INFO': {
        // "Translating: x/x" stays until done; other notices hide automatically after TOAST_MS
        const progressing = /^Đang dịch/.test(msg.text);
        showToast(msg.text, progressing ? 'info' : 'success', progressing ? 0 : TOAST_MS);
        break;
      }
      case 'SCROLL_TO_IMAGE': scrollToImage(msg.url); break;
      case 'DOWNLOAD_TRANSLATED': { // download button in the side panel: same file as the button on the image
        const e = overlayEntries.get(msg.url);
        if (e) downloadTranslatedImage(e);
        break;
      }
      case 'PANEL_STATE':     break; // the dock now reflects the in-page panel only
      case 'NOTEXT':          markNoText(msg.srcUrl); break;
      case 'MENU_TRANSLATE':  sendResponse({ handled: translateFromMenu(msg.srcUrl) }); break;
      case 'FETCH_BLOB':
        blobUrlToDataUrl(msg.url).then((dataUrl) => sendResponse({ dataUrl }), (err) => sendResponse({ error: String(err && err.message || err) }));
        return true;
    }
  });

  // ---------- Watch for image changes on the page -> tell the side panel to refresh its list ----------
  const OWN_SELECTOR = '#ocr-pill-host, #ocr-dock-host, #ocr-page-panel-host, .ocr-img-overlay, #ocr-panel, #ocr-toast, #ocr-confirm-host';
  function isOwnNode(n) {
    const el = n && n.nodeType === 1 ? n : (n && n.parentElement);
    return !!(el && el.closest && el.closest(OWN_SELECTOR));
  }
  function hasImg(n) {
    return n.nodeType === 1 && (n.tagName === 'IMG' || !!n.querySelector('img'));
  }
  let imgChangeTimer = null;
  function notifyImagesChanged() {
    clearTimeout(imgChangeTimer);
    imgChangeTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'IMAGES_CHANGED' }).catch(() => {});
    }, 700); // group several consecutive changes (re-rendered divs) into one update
  }
  function startImageWatch() {
    if (!document.body) return;
    new MutationObserver((records) => {
      for (const m of records) {
        if (isOwnNode(m.target)) continue; // skip changes made by the extension itself
        if (m.type === 'attributes') {
          if (m.target.tagName === 'IMG') { notifyImagesChanged(); return; }
        } else if ([...m.addedNodes, ...m.removedNodes].some((n) => !isOwnNode(n) && hasImg(n))) {
          notifyImagesChanged();
          return;
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src'],
    });
    // Lazy image: finished loading after src was set; report again on load
    document.addEventListener('load', (e) => {
      if (e.target && e.target.tagName === 'IMG' && !isOwnNode(e.target)) notifyImagesChanged();
    }, true);
  }
  startImageWatch();

  // Status/error notices: small toast at the bottom-right. ms = 0 keeps it until it is closed or a new notice appears.
  // The "Translate image" panel is no longer used for notices.
  const TOAST_MS = 20000; // auto-hide time for regular notices
  let toastTimer = null;
  function ensureToast() {
    let el = document.getElementById('ocr-toast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ocr-toast';
    el.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483646;max-width:340px;display:flex;align-items:flex-start;gap:10px;padding:10px 12px 10px 14px;border-radius:8px;background:#2c313a;color:#dcdfe4;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);border-left:4px solid #61afef;pointer-events:none;opacity:0;transition:opacity .2s;';
    const text = document.createElement('span');
    text.className = 'ocr-toast-text';
    text.style.cssText = 'all:unset;flex:1;min-width:0;word-break:break-word;';
    const close = document.createElement('button');
    close.className = 'ocr-toast-x';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Đóng');
    close.style.cssText = 'all:unset;cursor:pointer;color:#9aa3b2;font:18px/1 -apple-system,sans-serif;padding:0 2px;flex:none;';
    close.onmouseenter = () => { close.style.color = '#dcdfe4'; };
    close.onmouseleave = () => { close.style.color = '#9aa3b2'; };
    close.onclick = (e) => { e.stopPropagation(); hideToast(); };
    el.append(text, close);
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function showToast(text, kind = 'info', ms = TOAST_MS) {
    const el = ensureToast();
    const color = kind === 'error' ? '#e06c75' : kind === 'success' ? '#98c379' : '#61afef';
    el.style.borderLeftColor = color;
    el.querySelector('.ocr-toast-text').textContent = text;
    el.style.pointerEvents = 'auto'; // clickable, to close
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = null;
    if (ms > 0) toastTimer = setTimeout(hideToast, ms);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    const el = document.getElementById('ocr-toast');
    if (el) {
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    }
  }

  function showPanel(translated, original) {
    removePanel();

    panel = document.createElement('div');
    panel.id = 'ocr-panel';
    panel.innerHTML = `
      <div class="ocr-head">
        <span>Dịch ảnh</span>
        <button class="ocr-close" title="Đóng">×</button>
      </div>
      <div class="ocr-body"></div>
      <div class="ocr-foot">
        <button class="ocr-copy">Sao chép bản dịch</button>
      </div>`;

    const body = panel.querySelector('.ocr-body');
    if (original) {
      const o = document.createElement('div');
      o.className = 'ocr-original';
      o.textContent = original;
      body.appendChild(o);
    }
    const t = document.createElement('div');
    t.className = 'ocr-translated';
    t.textContent = translated;
    body.appendChild(t);

    panel.querySelector('.ocr-close').onclick = removePanel;
    panel.querySelector('.ocr-copy').onclick = () => navigator.clipboard.writeText(translated);

    document.body.appendChild(panel);
  }

  // Return only an <img> with exactly this image URL. Do not guess using the nearest right-clicked image,
  // because that would overlay another image's translation onto an image that was not translated
  function findImage(srcUrl) {
    if (lastContextImg && (lastContextImg.currentSrc === srcUrl || lastContextImg.src === srcUrl)) {
      return lastContextImg;
    }
    return [...document.images].find((i) => i.currentSrc === srcUrl || i.src === srcUrl) || null;
  }

  // Scroll the page (and any scrolling div containing the image) to the image with srcUrl. Used when clicking a translated or no-text image in the side panel.
  // If the image is taller than the viewport, align its top with the top of the viewport; otherwise center it.
  function scrollToImage(srcUrl) {
    const entry = overlayEntries.get(srcUrl);
    const img = (entry && entry.img.isConnected) ? entry.img : findImage(srcUrl);
    if (!img) return false;
    const host = findScrollHost(img);
    const viewH = host ? host.clientHeight : window.innerHeight;
    const tall = img.getBoundingClientRect().height > viewH * 0.9;
    img.scrollIntoView({ behavior: 'smooth', block: tall ? 'start' : 'center', inline: 'nearest' });
    return true;
  }

  // Measure with canvas: wrap lines to the box width, then pick the largest font size that fits
  // Font for the subtitle text. The user picks it in Settings (saved in chrome.storage.sync as subFont).
  // "manga" uses the bundled Anime Ace 3 BB Italic file; "system" uses the page's default fonts.
  const FONT_OPTIONS = {
    manga:  { family: 'MangaSubFont, system-ui, "Segoe UI", Roboto, sans-serif', file: 'fonts/AnimeAce3BB-Italic.ttf', name: 'MangaSubFont' },
    system: { family: 'system-ui, "Segoe UI", Roboto, sans-serif', file: null },
  };
  let FONT_FAMILY = FONT_OPTIONS.manga.family; // used for measuring, drawing and the text boxes
  let subFontId = 'manga'; // id of the font chosen in Settings
  const fontLoads = new Map(); // font id -> promise (each file is loaded once)

  // Loads the font file from the extension's bytes (not blocked by the page's CSP). Resolves true when the font is usable.
  function ensureFont(id) {
    const opt = FONT_OPTIONS[id];
    if (!opt || !opt.file) return Promise.resolve(true);
    if (!fontLoads.has(id)) {
      fontLoads.set(id, (async () => {
        try {
          const buf = await (await fetch(chrome.runtime.getURL(opt.file))).arrayBuffer();
          const ff = new FontFace(opt.name, buf);
          await ff.load();
          document.fonts.add(ff);
          return true;
        } catch (err) {
          console.warn('[OCR] không nạp được font, dùng font hệ thống', id, err);
          return false;
        }
      })());
    }
    return fontLoads.get(id);
  }

  // Lay out every translation again (text was measured with the previous font)
  function relayoutAll() {
    for (const e of overlayEntries.values()) { e.sizeKey = ''; layoutOverlay(e); }
    refreshSelection();
  }

  function applySubFont(id) {
    const opt = FONT_OPTIONS[id] || FONT_OPTIONS.manga;
    subFontId = FONT_OPTIONS[id] ? id : 'manga';
    FONT_FAMILY = opt.family;
    relayoutAll(); // show it right away with the fallback until the file is loaded
    ensureFont(id).then((ok) => { if (ok && FONT_FAMILY === opt.family) relayoutAll(); });
  }

  chrome.storage.sync.get({ subFont: 'manga' }).then((st) => applySubFont(st.subFont));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.subFont) applySubFont(changes.subFont.newValue);
  });
  let measureCtx = null;

  function wrapWords(text, maxW) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (measureCtx.measureText(test).width <= maxW || !cur) {
        cur = test;
      } else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // Font size of the translation relative to the original line spacing (adjust if the translated text looks bigger or smaller than the original)
  const FONT_CAP = 0.8;
  const LINE_H = 1.1; // line spacing; leaves room for Vietnamese diacritics so they are not clipped
  const MIN_FONT = 9; // hard floor: below this size the text is unreadable

  // maxSize: maximum font size based on the original text in the image (may be absent)
  function fitText(div, text, w, h, maxSize) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    let size = Math.max(MIN_FONT, Math.floor(h * 0.8));
    if (maxSize) size = Math.max(MIN_FONT, Math.min(size, Math.floor(maxSize)));
    let lines = [];
    let fitted = false;
    for (; size >= MIN_FONT; size--) {
      measureCtx.font = `${div.style.fontStyle} ${div.style.fontWeight} ${size}px ${div.style.fontFamily}`;
      lines = wrapWords(text, w);
      const fitsHeight = lines.length * size * LINE_H <= h + 1;
      const fitsWidth = lines.every((l) => measureCtx.measureText(l).width <= w + 1);
      if (fitsHeight && fitsWidth) { fitted = true; break; }
    }
    if (!fitted) size = MIN_FONT; // really does not fit: use the smallest size and accept a slight overflow
    measureCtx.font = `${div.style.fontStyle} ${div.style.fontWeight} ${size}px ${div.style.fontFamily}`;
    lines = wrapWords(text, w);
    div.style.fontSize = size + 'px';
    div.style.lineHeight = String(LINE_H);
    div.style.whiteSpace = 'pre';
    div.style.textAlign = 'center';
    div.textContent = lines.join('\n');
  }

  // Overlay layers currently shown. Each layer is re-aligned to its current <img>
  // whenever the page layout changes (another image finishes loading, resize), so it does not drift when the page shifts.
  const overlayEntries = new Map();
  let layoutQueued = false;

  // ---- Image inside a div with its own scrollbar ----
  // The overlay layer is placed INSIDE that scroll div (coordinates relative to the div), so it scrolls with the content
  // and is clipped by the div just like the image. Images placed directly on the page are still attached to <body> as before.
  const hostPosition = new WeakMap(); // scroll div -> original inline position value (to restore it later)

  function isClipping(v) {
    return v === 'auto' || v === 'scroll' || v === 'overlay' || v === 'hidden' || v === 'clip';
  }

  // Find the nearest scroll (or clipping) div that really contains the overflowing image; null if the image sits directly on the page
  function findScrollHost(img) {
    const htmlClips = isClipping(getComputedStyle(document.documentElement).overflowY);
    for (let el = img.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      if (el === document.body && !htmlClips) break; // body scrolls with the window: handle it like a normal image
      const cs = getComputedStyle(el);
      if (!isClipping(cs.overflowX) && !isClipping(cs.overflowY)) continue;
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) return el;
    }
    return null;
  }

  // An absolutely positioned layer only scrolls with a div when that div is its containing block; if the div is static, set it to relative temporarily
  function ensurePositioned(host) {
    if (getComputedStyle(host).position !== 'static') return;
    if (!hostPosition.has(host)) hostPosition.set(host, host.style.position);
    host.style.position = 'relative';
  }

  function releaseHost(host) {
    if (!host || !hostPosition.has(host)) return;
    for (const e of overlayEntries.values()) if (e.host === host) return; // another image still uses this host
    host.style.position = hostPosition.get(host);
    hostPosition.delete(host);
  }

  // ---- Select a subtitle box and resize it by dragging its handles ----
  // Position and size are saved as fractions of the image size, so the edit still fits when the image is resized or scrolled
  let selected = null; // { entry, idx } of the box that is selected
  const MIN_BOX = 16;  // smallest box size in px
  const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const HANDLE_FX = { nw: 0, n: 0.5, ne: 1, e: 1, se: 1, s: 0.5, sw: 0, w: 0 };
  const HANDLE_FY = { nw: 0, n: 0, ne: 0, e: 0.5, se: 1, s: 1, sw: 1, w: 0.5 };
  const HANDLE_CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

  function selectBox(entry, idx) {
    selected = { entry, idx };
    refreshSelection();
  }

  function deselectBox() {
    if (selected) {
      for (const b of selected.entry.layer.querySelectorAll('[data-idx]')) b.style.cursor = 'pointer';
    }
    if (selected && selected.entry.selEl) selected.entry.selEl.remove();
    if (selected) selected.entry.selEl = null;
    selected = null;
  }

  function buildSelection(entry, idx) {
    const frame = document.createElement('div');
    frame.className = 'ocr-sel';
    Object.assign(frame.style, {
      all: 'initial', position: 'absolute', boxSizing: 'border-box',
      border: '2px dashed #4da3ff', pointerEvents: 'none', zIndex: '2147483641',
    });
    for (const d of HANDLE_DIRS) {
      const hd = document.createElement('div');
      hd.className = 'ocr-h';
      hd.dataset.dir = d;
      hd.dataset.fx = String(HANDLE_FX[d]);
      hd.dataset.fy = String(HANDLE_FY[d]);
      Object.assign(hd.style, {
        all: 'initial', position: 'absolute', boxSizing: 'border-box', width: '10px', height: '10px',
        transform: 'translate(-50%, -50%)', background: '#fff', border: '1px solid #4da3ff', borderRadius: '2px',
        pointerEvents: 'auto', cursor: HANDLE_CURSOR[d],
      });
      hd.addEventListener('pointerdown', (e) => startResize(e, entry, idx, d));
      frame.appendChild(hd);
    }
    // Delete icon: top-right corner, inside the box
    const del = document.createElement('div');
    del.className = 'ocr-del';
    Object.assign(del.style, {
      all: 'initial', position: 'absolute', right: '8px', top: '8px', width: '22px', height: '22px',
      boxSizing: 'border-box', borderRadius: '6px', background: '#e06c75', display: 'flex',
      alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', cursor: 'pointer',
      boxShadow: '0 1px 4px rgba(0,0,0,.35)',
    });
    del.title = 'Xóa khung sub';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
    del.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openDeleteConfirm(entry, idx); });
    frame.appendChild(del);
    return frame;
  }

  // Place the frame and its handles on the selected box (called after every layout and during a drag)
  function refreshSelection() {
    if (!selected) return;
    const { entry, idx } = selected;
    if (overlayEntries.get(entry.srcUrl) !== entry) { deselectBox(); return; }
    const box = entry.layer.querySelector(`[data-idx="${idx}"]`);
    if (!box) { deselectBox(); return; }
    if (!entry.selEl || !entry.selEl.isConnected) {
      entry.selEl = buildSelection(entry, idx);
      entry.layer.appendChild(entry.selEl);
    }
    const w = parseFloat(box.style.width), h = parseFloat(box.style.height);
    box.style.cursor = 'move';
    Object.assign(entry.selEl.style, {
      left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height,
    });
    for (const hd of entry.selEl.querySelectorAll('.ocr-h')) {
      hd.style.left = (Number(hd.dataset.fx) * w) + 'px';
      hd.style.top = (Number(hd.dataset.fy) * h) + 'px';
    }
  }

  function startResize(e, entry, idx, dir) {
    e.preventDefault();
    e.stopPropagation();
    const box = entry.layer.querySelector(`[data-idx="${idx}"]`);
    if (!box) return;
    const hd = e.currentTarget;
    hd.setPointerCapture(e.pointerId);
    const LW = parseFloat(entry.layer.style.width), LH = parseFloat(entry.layer.style.height);
    const start = {
      cx: e.clientX, cy: e.clientY,
      x: parseFloat(box.style.left), y: parseFloat(box.style.top),
      w: parseFloat(box.style.width), h: parseFloat(box.style.height),
    };
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    let cur = { x: start.x, y: start.y, w: start.w, h: start.h };
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - start.cx, dy = ev.clientY - start.cy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; // ignore tiny jitter from a click
      if (dir === 'move') {
        // Keep the size, stay inside the image
        cur = {
          x: clamp(start.x + dx, 0, LW - start.w),
          y: clamp(start.y + dy, 0, LH - start.h),
          w: start.w, h: start.h,
        };
      } else {
        let L = start.x, R = start.x + start.w, T = start.y, B = start.y + start.h;
        if (dir.includes('w')) L = clamp(start.x + dx, 0, R - MIN_BOX);
        if (dir.includes('e')) R = clamp(start.x + start.w + dx, L + MIN_BOX, LW);
        if (dir.includes('n')) T = clamp(start.y + dy, 0, B - MIN_BOX);
        if (dir.includes('s')) B = clamp(start.y + start.h + dy, T + MIN_BOX, LH);
        cur = { x: L, y: T, w: R - L, h: B - T };
      }
      Object.assign(box.style, { left: cur.x + 'px', top: cur.y + 'px', width: cur.w + 'px', height: cur.h + 'px' });
      refreshSelection();
    };
    const onUp = () => {
      hd.removeEventListener('pointermove', onMove);
      hd.removeEventListener('pointerup', onUp);
      hd.removeEventListener('pointercancel', onUp);
      if (!moved) { refreshSelection(); return; }
      // Save the new geometry as fractions of the image, then rebuild the text so it fits the new size
      entry.boxOverrides = entry.boxOverrides || {};
      entry.boxOverrides[idx] = { x: cur.x / LW, y: cur.y / LH, w: cur.w / LW, h: cur.h / LH };
      entry.sizeKey = '';
      layoutOverlay(entry);
      refreshSelection();
    };
    hd.addEventListener('pointermove', onMove);
    hd.addEventListener('pointerup', onUp);
    hd.addEventListener('pointercancel', onUp);
  }

  // Shapes offered in the edit toolbar
  const SHAPE_ICON = (inner) => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`;
  const SHAPE_OPTIONS = [
    ['rect', SHAPE_ICON('<rect x="2" y="4" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>')],
    ['ellipse', SHAPE_ICON('<ellipse cx="8" cy="8" rx="6" ry="4" fill="none" stroke="currentColor" stroke-width="1.6"/>')],
  ];

  // Apply a box's style (font, colour, weight, italic) to its element. With no saved style, the global font and default colour are used.
  function styleBox(box, st) {
    const font = st && st.font && FONT_OPTIONS[st.font] ? st.font : subFontId;
    box.style.fontFamily = FONT_OPTIONS[font].family;
    box.style.color = (st && st.color) || box.dataset.defColor || '#000000';
    box.style.fontWeight = (st && st.weight) || '400';
    box.style.fontStyle = st && st.italic ? 'italic' : 'normal';
  }

  // Double-click a translated box: edit its text and style. A toolbar above the box changes font, colour, weight and italic.
  // Enter (or click outside) saves, Shift+Enter adds a line, Esc cancels text and style changes.
  function startTextEdit(e, entry, idx) {
    e.preventDefault();
    e.stopPropagation();
    const box = entry.layer.querySelector(`[data-idx="${idx}"]`);
    if (!box || box.isContentEditable) return;
    const prevStyle = entry.boxStyles && entry.boxStyles[idx] ? { ...entry.boxStyles[idx] } : null;
    let st = { ...(prevStyle || {}) };
    let done = false;

    box.contentEditable = 'true';
    box.style.cursor = 'text';
    box.style.outline = '2px solid #4da3ff';
    box.style.userSelect = 'text';

    const setStyle = (patch) => {
      st = { ...st, ...patch };
      entry.boxStyles = entry.boxStyles || {};
      entry.boxStyles[idx] = { ...st };
      styleBox(box, st); // live preview; the text is fitted again when editing ends
    };

    // ---- toolbar above the box ----
    const tb = document.createElement('div');
    tb.className = 'ocr-tb';
    Object.assign(tb.style, {
      all: 'initial', position: 'absolute', display: 'flex', alignItems: 'center', gap: '6px',
      padding: '6px 8px', background: '#2c313a', borderRadius: '10px', boxShadow: '0 4px 14px rgba(0,0,0,.35)',
      zIndex: '2147483642', pointerEvents: 'auto', font: '12px system-ui,"Segoe UI",sans-serif',
      color: '#dcdfe4', whiteSpace: 'nowrap',
    });
    tb.addEventListener('pointerdown', (ev) => ev.stopPropagation());

    // Dropdown styled like the language picker: a closed trigger and a dark list (no search box)
    let openList = null; // only one list is open at a time
    // A label that starts with "<" is icon markup (SVG); anything else is plain text
    const setLabel = (el, text) => {
      if (text.startsWith('<')) el.innerHTML = text;
      else el.textContent = text;
    };
    const mkDropdown = (opts, value, onChange, compact = false) => {
      const FONT = '12px system-ui,"Segoe UI",sans-serif';
      const wrap = document.createElement('div');
      Object.assign(wrap.style, { all: 'initial', position: 'relative', display: 'inline-block' });

      const trigger = document.createElement('div');
      const lbl = document.createElement('span');
      const arrow = document.createElement('span');
      arrow.innerHTML = '<svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M0 0h8L4 5z" fill="#aab1bf"/></svg>';
      Object.assign(arrow.style, { all: 'initial', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' });
      Object.assign(lbl.style, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: '1', color: '#dcdfe4', font: FONT });
      Object.assign(trigger.style, {
        all: 'initial', display: 'flex', alignItems: 'center', justifyContent: compact ? 'center' : 'space-between', gap: compact ? '6px' : '8px',
        boxSizing: 'border-box', height: '26px', minWidth: compact ? '56px' : '84px', padding: '0 8px', borderRadius: '6px',
        background: '#1e2228', border: '1px solid #3a3f4b', color: '#dcdfe4', font: FONT,
        cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
      });
      trigger.append(lbl, arrow);

      const list = document.createElement('div');
      Object.assign(list.style, {
        all: 'initial', display: 'none', position: 'absolute', left: '0', top: 'calc(100% + 4px)',
        minWidth: '100%', boxSizing: 'border-box', background: '#2c313a', border: '1px solid #3a3f4b',
        borderRadius: '8px', boxShadow: '0 10px 24px rgba(0,0,0,.45)', padding: '4px 0',
        zIndex: '2147483643', font: FONT, color: '#dcdfe4',
      });

      const rows = [];
      const paint = () => {
        const hit = opts.find(([v]) => v === value) || opts[0];
        setLabel(lbl, hit[1]);
        for (const [row, v] of rows) {
          row.style.color = v === value ? '#61afef' : '#dcdfe4';
          row.style.fontWeight = v === value ? '600' : '400';
        }
      };
      for (const [v, label] of opts) {
        const row = document.createElement('div');
        setLabel(row, label);
        Object.assign(row.style, {
          all: 'initial', display: 'block', padding: '6px 10px', whiteSpace: 'nowrap',
          cursor: 'pointer', font: FONT,
        });
        row.onmouseenter = () => { row.style.background = '#3f4653'; };
        row.onmouseleave = () => { row.style.background = ''; };
        row.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in the text
        row.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          value = v;
          paint();
          list.style.display = 'none';
          openList = null;
          onChange(v);
        });
        rows.push([row, v]);
        list.appendChild(row);
      }
      paint();

      trigger.addEventListener('mousedown', (ev) => ev.preventDefault());
      trigger.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const willOpen = list.style.display === 'none';
        if (openList && openList !== list) openList.style.display = 'none';
        list.style.display = willOpen ? 'block' : 'none';
        openList = willOpen ? list : null;
      });

      wrap.append(trigger, list);
      return wrap;
    };

    const fontSel = mkDropdown([['manga', 'Manga'], ['system', 'Hệ thống']], st.font || subFontId, (v) => {
      setStyle({ font: v });
      ensureFont(v).then(() => styleBox(box, st)); // the file may still be loading
      box.focus();
    });
    const shapeSel = mkDropdown(SHAPE_OPTIONS, st.shape || box.dataset.defShape || 'rect', (v) => {
      setStyle({ shape: v });
      box.style.borderRadius = v === 'ellipse' ? '50%' : '8px'; // live preview; the box is laid out again when editing ends
      box.focus();
    }, true);
    const boldBtn = document.createElement('button');
    boldBtn.type = 'button';
    boldBtn.textContent = 'B';
    const isBold = () => st.weight === '700';
    const paintBold = () => {
      const on = isBold();
      Object.assign(boldBtn.style, {
        all: 'initial', display: 'inline-block', boxSizing: 'border-box', width: '26px', height: '26px',
        margin: '0', borderRadius: '6px', border: '1px solid ' + (on ? '#4da3ff' : '#3a3f4b'),
        cursor: 'pointer', textAlign: 'center', lineHeight: '24px',
        font: '800 13px system-ui,sans-serif',
        background: on ? '#4da3ff' : '#1e2228', color: on ? '#fff' : '#dcdfe4',
      });
    };
    paintBold();
    boldBtn.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in the text
    boldBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      setStyle({ weight: isBold() ? '400' : '700' }); // bold on, then back to normal
      paintBold();
    });

    // Text colour: an "A" with a bar in the current colour. The whole control opens the colour picker.
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = st.color || box.dataset.defColor || '#000000';
    Object.assign(colorInput.style, {
      all: 'initial', position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      margin: '0', padding: '0', border: '0', opacity: '0', cursor: 'pointer',
    });
    const color = document.createElement('div');
    const colorA = document.createElement('span');
    colorA.textContent = 'A';
    const colorBar = document.createElement('span');
    Object.assign(colorBar.style, {
      all: 'initial', display: 'block', width: '14px', height: '3px', marginTop: '1px',
      borderRadius: '1px', background: colorInput.value,
    });
    Object.assign(color.style, {
      all: 'initial', position: 'relative', display: 'inline-flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', width: '26px', height: '26px',
      margin: '0', borderRadius: '6px', border: '1px solid #3a3f4b', background: '#1e2228', cursor: 'pointer',
      color: '#dcdfe4', font: '700 14px system-ui,sans-serif', lineHeight: '1',
    });
    colorInput.addEventListener('input', () => {
      setStyle({ color: colorInput.value });
      colorBar.style.background = colorInput.value;
    });
    color.append(colorA, colorBar, colorInput);

    const italicBtn = document.createElement('button');
    italicBtn.type = 'button';
    italicBtn.textContent = 'I';
    const paintItalic = () => {
      const on = !!st.italic;
      Object.assign(italicBtn.style, {
        all: 'initial', display: 'inline-block', boxSizing: 'border-box', width: '26px', height: '26px',
        margin: '0', borderRadius: '6px', border: '1px solid ' + (on ? '#4da3ff' : '#3a3f4b'),
        cursor: 'pointer', textAlign: 'center', lineHeight: '24px',
        font: 'italic 700 13px system-ui,sans-serif',
        background: on ? '#4da3ff' : '#1e2228', color: on ? '#fff' : '#dcdfe4',
      });
    };
    paintItalic();
    italicBtn.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in the text
    italicBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      setStyle({ italic: !st.italic });
      paintItalic();
    });

    tb.append(fontSel, shapeSel, boldBtn, italicBtn, color);
    entry.layer.appendChild(tb);
    // Above the box, or below it when there is no room above
    const bx = parseFloat(box.style.left), by = parseFloat(box.style.top), bh = parseFloat(box.style.height);
    let ty = by - tb.offsetHeight - 6;
    if (ty < 0) ty = by + bh + 6;
    tb.style.left = Math.max(0, bx) + 'px';
    tb.style.top = ty + 'px';

    // Select the whole text so typing replaces it
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = (save) => {
      if (done) return;
      done = true;
      box.removeEventListener('blur', onBlur);
      box.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocDown, true);
      const typed = save ? box.innerText.replace(/\n$/, '') : '';
      const savedText = entry.textOverrides && entry.textOverrides[idx] != null ? entry.textOverrides[idx] : '';
      if (isAddedBox(entry, idx) && (save ? !typed.trim() : !savedText.trim())) {
        tb.remove();
        removeAddedBox(entry, idx); // a new box without text is cancelled
        entry.sizeKey = '';
        layoutOverlay(entry);
        refreshSelection();
        return;
      }
      if (save) {
        const text = box.innerText.replace(/\n$/, '');
        entry.textOverrides = entry.textOverrides || {};
        entry.textOverrides[idx] = text;
      } else if (prevStyle) {
        entry.boxStyles[idx] = prevStyle; // cancel: go back to the previous style
      } else if (entry.boxStyles) {
        delete entry.boxStyles[idx];
      }
      tb.remove();
      entry.sizeKey = ''; // rebuild the box with the saved text and style
      layoutOverlay(entry);
      refreshSelection();
    };
    // Focus moving to the toolbar (font, weight, colour) is not the end of editing
    const onBlur = (ev) => {
      if (ev.relatedTarget && tb.contains(ev.relatedTarget)) return;
      finish(true);
    };
    const onKey = (ev) => {
      ev.stopPropagation(); // keys typed in the box must not trigger page shortcuts
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    };
    // Clicking anywhere outside the box and its toolbar saves
    const onDocDown = (ev) => {
      if (tb.contains(ev.target) || box.contains(ev.target)) return;
      finish(true);
    };
    box.addEventListener('blur', onBlur);
    box.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDocDown, true);
  }

  // Press anywhere on the box (including over the text) and drag to move it. Selects the box if it is not selected yet.
  function onBoxPointerDown(e, entry, idx) {
    e.stopPropagation();
    const box = entry.layer.querySelector(`[data-idx="${idx}"]`);
    if (box && box.isContentEditable) return; // editing text: let the caret move normally
    if (!(selected && selected.entry === entry && selected.idx === idx)) selectBox(entry, idx);
    if (box) box.style.cursor = 'move';
    startResize(e, entry, idx, 'move');
  }

  // Click anywhere outside the translated boxes (and their handles): deselect
  document.addEventListener('pointerdown', (e) => {
    if (!selected) return;
    if (e.target && e.target.closest && e.target.closest('.ocr-img-overlay')) return;
    deselectBox();
  }, true);

  // ---- Added subtitle boxes: drag a region on a translated image to create one ----
  // Added boxes are stored in entry.addedBoxes with ids 'a1', 'a2', ...; their geometry lives in boxOverrides like the others.
  const isAddedBox = (entry, id) => (entry.addedBoxes || []).some((a) => a.id === id);

  function removeAddedBox(entry, id) {
    entry.addedBoxes = (entry.addedBoxes || []).filter((a) => a.id !== id);
    for (const store of [entry.boxOverrides, entry.textOverrides, entry.boxStyles, entry.deletedBoxes]) {
      if (store) delete store[id];
    }
    if (selected && selected.entry === entry && selected.idx === id) deselectBox();
  }

  // The boxes to lay out: the ones from Gemini (numbered by their position) and the ones the user added
  function layoutItems(entry) {
    const list = (entry.items || []).map((it, i) => ({ ...it, key: i }));
    for (const a of entry.addedBoxes || []) {
      list.push({
        key: a.id, added: true, translated: '', shape: 'rect',
        box: { x0: 0, y0: 0, x1: entry.width, y1: entry.height }, // real position comes from boxOverrides
        bg: { r: 255, g: 255, b: 255, dark: false },              // white background
      });
    }
    return list;
  }

  function createAddedBox(entry, r, W, H) {
    entry.addedSeq = (entry.addedSeq || 0) + 1;
    const id = 'a' + entry.addedSeq;
    entry.addedBoxes = [...(entry.addedBoxes || []), { id }];
    entry.boxOverrides = { ...(entry.boxOverrides || {}), [id]: { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H } };
    entry.sizeKey = '';
    layoutOverlay(entry);
    selectBox(entry, id);
    // Start typing straight away; the empty box is removed if nothing is typed
    startTextEdit({ preventDefault() {}, stopPropagation() {} }, entry, id);
  }

  let drawing = null; // { entry, r, x0, y0, x1, y1, el } while the user drags a new box
  const clampTo = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const entry = [...overlayEntries.values()].find((en) => en.img === img && en.layer.style.display !== 'none');
    if (!entry) return;
    e.preventDefault(); // no native image drag
    e.stopPropagation();
    img.draggable = false;
    deselectBox();
    const r = img.getBoundingClientRect();
    const x0 = clampTo(e.clientX - r.left, 0, r.width);
    const y0 = clampTo(e.clientY - r.top, 0, r.height);
    const el = document.createElement('div');
    el.className = 'ocr-draw';
    Object.assign(el.style, {
      all: 'initial', position: 'absolute', left: x0 + 'px', top: y0 + 'px', width: '0px', height: '0px',
      boxSizing: 'border-box', border: '2px dashed #4da3ff', background: 'rgba(77,163,255,.15)',
      pointerEvents: 'none', zIndex: '2147483640',
    });
    entry.layer.appendChild(el);
    drawing = { entry, r, x0, y0, x1: x0, y1: y0, el };
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const d = drawing;
    d.x1 = clampTo(e.clientX - d.r.left, 0, d.r.width);
    d.y1 = clampTo(e.clientY - d.r.top, 0, d.r.height);
    Object.assign(d.el.style, {
      left: Math.min(d.x0, d.x1) + 'px', top: Math.min(d.y0, d.y1) + 'px',
      width: Math.abs(d.x1 - d.x0) + 'px', height: Math.abs(d.y1 - d.y0) + 'px',
    });
  }, true);

  const endDrawing = () => {
    if (!drawing) return;
    const d = drawing;
    drawing = null;
    d.el.remove();
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w > 4 || h > 4) suppressClick = true;
    window.getSelection()?.removeAllRanges();
    if (w < 24 || h < 24) return; // a plain click, not a new box
    createAddedBox(d.entry, { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w, h }, d.r.width, d.r.height);
  };
  document.addEventListener('pointerup', endDrawing, true);
  document.addEventListener('pointercancel', endDrawing, true);

  // Pressing on an image and moving starts the browser's own image drag (the picture moves instead of a box being drawn)
  document.addEventListener('dragstart', (e) => {
    if (drawing || e.target instanceof HTMLImageElement) e.preventDefault();
  }, true);

  // A drag that drew a box must not also count as a click on the image (e.g. a link around it)
  let suppressClick = false;
  document.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Confirm dialog (its own shadow root so the page's CSS does not affect it)
  function openDeleteConfirm(entry, idx) {
    const host = document.createElement('div');
    host.id = 'ocr-confirm-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = `
      .bg{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font:14px/1.45 system-ui,"Segoe UI",sans-serif;opacity:0;transition:opacity .18s ease;}
      .bg.show{opacity:1;}
      .dlg{background:#fff;color:#111;border-radius:10px;padding:18px 20px;width:300px;box-sizing:border-box;box-shadow:0 12px 36px rgba(0,0,0,.35);transform:scale(.92);transition:transform .18s ease;}
      .bg.show .dlg{transform:scale(1);}
      .t{font-weight:600;font-size:15px;margin-bottom:8px;}
      .m{color:#555;margin-bottom:16px;}
      .row{display:flex;justify-content:flex-end;gap:8px;}
      button{font:inherit;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;}
      .no{background:#eef0f3;color:#222;}
      .yes{background:#e06c75;color:#fff;}`;
    root.appendChild(st);
    const bg = document.createElement('div');
    bg.className = 'bg';
    bg.innerHTML = '<div class="dlg" role="dialog" aria-modal="true">' +
      '<div class="t">Xóa khung sub này?</div>' +
      '<div class="m">Khung sub sẽ bị xóa khỏi ảnh đã dịch.</div>' +
      '<div class="row"><button class="no" type="button">Hủy</button><button class="yes" type="button">Xóa</button></div></div>';
    root.appendChild(bg);
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      document.removeEventListener('keydown', onKey, true);
      deselectBox(); // cancelling must not leave the box in drag mode
      bg.classList.remove('show');
      setTimeout(() => host.remove(), 180); // wait for the fade-out to finish
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bg.querySelector('.no').onclick = close;
    bg.querySelector('.yes').onclick = () => { close(); deleteBox(entry, idx); };
    bg.onclick = (e) => { if (e.target === bg) close(); };
    document.addEventListener('keydown', onKey, true);
    (document.body || document.documentElement).appendChild(host);
    deselectBox(); // the box is not in drag mode while the dialog is open
    requestAnimationFrame(() => bg.classList.add('show'));
  }

  // Remove one translated box from the image (kept in the translation until the image is translated again)
  function deleteBox(entry, idx) {
    if (overlayEntries.get(entry.srcUrl) !== entry) return;
    if (isAddedBox(entry, idx)) { removeAddedBox(entry, idx); entry.sizeKey = ''; layoutOverlay(entry); return; }
    entry.deletedBoxes = entry.deletedBoxes || {};
    entry.deletedBoxes[idx] = true;
    if (selected && selected.entry === entry && selected.idx === idx) deselectBox();
    entry.sizeKey = '';
    layoutOverlay(entry);
  }

  function removeEntry(entry) {
    layoutObserver.unobserve(entry.img);
    if (selected && selected.entry === entry) deselectBox();
    entry.layer.remove();
    if (entry.pin) { entry.pin.el.remove(); entry.pin = null; }
    if (entry.dlPin) { entry.dlPin.el.remove(); entry.dlPin = null; }
    overlayEntries.delete(entry.srcUrl);
    releaseHost(entry.host);
  }

  // Attach the translation to the new <img> / new link and update the URL key (including the "Translated" state in the side panel).
  // A different aspect ratio means a different image: remove the translation so it does not sit in the wrong place.
  function rebindEntry(entry, newImg) {
    const aspectOld = entry.width / entry.height;
    const aspectNew = newImg.naturalWidth > 0
      ? newImg.naturalWidth / newImg.naturalHeight
      : newImg.getBoundingClientRect().width / Math.max(1, newImg.getBoundingClientRect().height);
    if (Math.abs(aspectNew / aspectOld - 1) > 0.05) {
      removeEntry(entry);
      return false;
    }
    const oldUrl = entry.srcUrl;
    const newUrl = imgKey(newImg);
    if (!newUrl) return false; // new image has no link yet (still loading): retry next time
    if (newImg !== entry.img) {
      layoutObserver.unobserve(entry.img);
      entry.img = newImg;
      layoutObserver.observe(newImg);
    }
    if (newUrl !== oldUrl) {
      const other = overlayEntries.get(newUrl);
      if (other && other !== entry) removeEntry(other);
      overlayEntries.delete(oldUrl);
      entry.srcUrl = newUrl;
      entry.layer.dataset.src = newUrl;
      overlayEntries.set(newUrl, entry);
      try { chrome.runtime.sendMessage({ type: 'REBIND_URL', oldUrl, newUrl }, () => void chrome.runtime.lastError); } catch (_) {}
    }
    entry.sizeKey = '';
    return true;
  }

  function layoutOverlay(entry) {
    const { layer, width, height, items } = entry;
    let img = entry.img;
    if (!img.isConnected) {
      // The page rebuilt the <img> (common when the window is resized, e.g. the side panel opens): find the image again by its URL
      // and attach the translation to it instead of deleting it. If it is not found, hide temporarily and retry at the next check.
      // Matching is by image link only (never by the image's index/position in the page)
      const again = findImage(entry.srcUrl);
      if (again && again.isConnected && rebindEntry(entry, again)) {
        img = entry.img;
      } else {
        if (overlayEntries.get(entry.srcUrl) === entry) { // not removed for aspect-ratio reasons: hide temporarily and retry later
          layer.style.display = 'none';
          hideTranslatedPins(entry);
        }
        return;
      }
    } else if (imgKey(img) && imgKey(img) !== entry.srcUrl) {
      // Same <img> element, but the page changed to a different link: update the link and keep the translation
      if (!rebindEntry(entry, img)) return;
    }
    const rect = img.getBoundingClientRect();
    const sx = rect.width / width;
    const sy = rect.height / height;

    const host = findScrollHost(img);
    if (host !== entry.host) {
      const prev = entry.host;
      entry.host = host;
      if (host) layoutObserver.observe(host);
      if (prev) releaseHost(prev);
    }
    const parent = host || document.body;
    if (layer.parentNode !== parent) {
      if (host) ensurePositioned(host);
      parent.appendChild(layer); // also runs when the page rebuilds the DOM and removes the layer
      entry.sizeKey = '';
    }

    let left, top;
    if (host) {
      const hr = host.getBoundingClientRect();
      left = rect.left - hr.left - host.clientLeft + host.scrollLeft;
      top = rect.top - hr.top - host.clientTop + host.scrollTop;
    } else {
      left = rect.left + window.scrollX;
      top = rect.top + window.scrollY;
    }
    Object.assign(layer.style, {
      display: entry.hidden || rect.width < 1 || rect.height < 1 ? 'none' : 'block',
      left: left + 'px',
      top: top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });
    updatePin(entry);

    // Re-render the text only when the image size changes; for scrolling or moving only, just move the layer
    const sizeKey = rect.width.toFixed(1) + 'x' + rect.height.toFixed(1);
    if (entry.sizeKey === sizeKey) return;
    entry.sizeKey = sizeKey;

    layer.textContent = '';
    const pad = 2;
    for (const it of layoutItems(entry)) {
      const idx = it.key;
      if (!it.translated && !it.added) continue; // added boxes start empty; the user types their text in
      if (entry.deletedBoxes && entry.deletedBoxes[idx]) continue; // removed by the user
      const stored = entry.boxStyles && entry.boxStyles[idx];
      const ellipse = stored && stored.shape ? stored.shape === 'ellipse' : it.shape === 'ellipse';
      // Round bubble/oval: shrink by 1% so the original outline is still visible; the text box is taken from inside the ellipse
      const inset = ellipse ? 0.01 : 0;
      const bw = (it.box.x1 - it.box.x0) * sx;
      const bh = (it.box.y1 - it.box.y0) * sy;
      let x = it.box.x0 * sx + (ellipse ? bw * inset : -pad);
      let y = it.box.y0 * sy + (ellipse ? bh * inset : -pad);
      let w = ellipse ? bw * (1 - 2 * inset) : bw + 2 * pad;
      let h = ellipse ? bh * (1 - 2 * inset) : bh + 2 * pad;
      // The user resized this box: use the saved geometry (fractions of the image size)
      const ov = entry.boxOverrides && entry.boxOverrides[idx];
      if (ov) { x = ov.x * rect.width; y = ov.y * rect.height; w = ov.w * rect.width; h = ov.h * rect.height; }
      if (w < 6 || h < 6) continue;
      // Text area: for an ellipse, use only the rectangle that fits inside it (~73%); for a rectangle, keep an even 7% margin
      // (minimum 6px) so the text does not touch or get clipped at the edges
      const k = ellipse ? 0.73 : 1; // const k = ellipse ? 0.73 : 1; // 0.78 previously made text touch the edge; 0.73 is a moderate level
      const mx = ellipse ? (w - w * k) / 2 : Math.max(6, Math.min(w, h) * 0.07);
      const my = ellipse ? (h - h * k) / 2 : Math.max(6, Math.min(w, h) * 0.07);
      const tw = w - 2 * mx;
      const th = h - 2 * my;
      // Corner radius for rectangular boxes (based on the short side, max 28px)
      const radius = ellipse ? '50%' : Math.min(28, Math.min(w, h) * 0.12) + 'px';

      const div = document.createElement('div');
      Object.assign(div.style, {
        all: 'initial',
        position: 'absolute',
        left: x + 'px',
        top: y + 'px',
        width: w + 'px',
        height: h + 'px',
        background: `rgb(${it.bg.r},${it.bg.g},${it.bg.b})`,
        color: it.bg.dark ? '#fff' : '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        overflow: 'visible', // overflow only once the font has reached the floor size
        lineHeight: String(LINE_H),
        fontFamily: FONT_FAMILY,
        boxSizing: 'border-box',
        borderRadius: radius,
        padding: `${my}px ${mx}px`,
      });
      layer.appendChild(div);
      div.dataset.idx = String(idx);
      div.style.pointerEvents = 'auto';
      div.style.cursor = 'pointer';
      div.addEventListener('pointerdown', (e) => onBoxPointerDown(e, entry, idx));
      div.addEventListener('dblclick', (e) => startTextEdit(e, entry, idx));
      // Original font size from Gemini as a cap (never larger than the original text); if absent, use the measured line spacing
      const cap = it.fontPx ? it.fontPx * sy : it.linePx ? it.linePx * sy * FONT_CAP : 0;
      div.dataset.defColor = it.bg.dark ? '#ffffff' : '#000000';
      div.dataset.defShape = it.shape === 'ellipse' ? 'ellipse' : 'rect';
      styleBox(div, entry.boxStyles && entry.boxStyles[idx]);
      const text = entry.textOverrides && entry.textOverrides[idx] != null ? entry.textOverrides[idx] : it.translated;
      fitText(div, text, tw, th, cap);
    }
  }

  function layoutAllOverlays() {
    for (const entry of [...overlayEntries.values()]) layoutOverlay(entry);
    updateAllPendingPins();
    refreshSelection();
  }

  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layoutAllOverlays();
    });
  }

  const layoutObserver = new ResizeObserver(scheduleLayout);
  if (document.body) layoutObserver.observe(document.body);
  window.addEventListener('resize', scheduleLayout);
  // Scroll in any div (scroll does not bubble, so catch it in the capture phase)
  window.addEventListener('scroll', scheduleLayout, true);

  // An image above finished loading and pushed the image below it without resizing it: check periodically
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!overlayEntries.size && !pendingPins.size) {
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      scheduleLayout();
    }, 400);
  }

  function overlayImage({ srcUrl, width, height, items }) {
    queuedKeys.delete(srcUrl);
    const img = findImage(srcUrl);
    if (!img) {
      console.warn('[OCR] không tìm thấy <img> cho', srcUrl);
      return;
    }
    // Replace only the translation of this image; keep the translations of other images
    const old = overlayEntries.get(srcUrl);
    if (old) removeEntry(old);
    document.querySelectorAll('.ocr-img-overlay').forEach((n) => {
      if (n.dataset.src === srcUrl) n.remove();
    });

    const layer = document.createElement('div');
    layer.className = 'ocr-img-overlay';
    layer.dataset.src = srcUrl;
    Object.assign(layer.style, {
      all: 'initial',
      position: 'absolute',
      zIndex: '2147483640',
      pointerEvents: 'none',
    });

    // layoutOverlay attaches the layer to the right place itself (body or the scroll div containing the image)
    const entry = { srcUrl, img, layer, width, height, items, host: undefined, sizeKey: '', hidden: false };
    overlayEntries.set(srcUrl, entry);
    layoutObserver.observe(img);
    entry.flashUntil = Date.now() + 2500; // flash as soon as the button appears, within 2.5 seconds after translation finishes
    entry.flashed = false;
    layoutOverlay(entry);
    removePendingPin(srcUrl); // the fixed button for the translation (updatePin in layoutOverlay) replaces it right away
    if (pillImg === img) hidePill(); // the hover button yields to the fixed button
    startPolling();
  }

  // Wait for an image to finish loading, up to 4 seconds
  function waitLoaded(img) {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
      setTimeout(resolve, 4000);
    });
  }

  // Read a blob image inside the page (same origin, so fetch works) and return a data URL.
  // Formats other than png/jpeg/webp (gif, avif, ...) are redrawn as PNG.
  const GEMINI_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  async function blobUrlToDataUrl(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const mime = (blob.type || '').split(';')[0];
      if (GEMINI_MIMES.includes(mime)) return await readAsDataUrl(blob);
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      return c.toDataURL('image/png');
    } catch (err) {
      // blob was revoked or blocked by CSP: redraw from the <img> currently displayed
      const img = findImage(url);
      if (!img || !img.naturalWidth) throw err;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    }
  }

  // Thumbnail for the side panel (the side panel cannot open the page's blob: URLs)
  function makeThumb(img) {
    try {
      const w = 160;
      const sh = Math.min(img.naturalHeight, img.naturalWidth * 3);
      const h = Math.max(1, Math.round((w * sh) / img.naturalWidth));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, img.naturalWidth, sh, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.7);
    } catch (_) {
      return null;
    }
  }

  // List of large images on the page, without duplicate URLs
  function collectImageUrls() {
    const seen = new Set();
    const out = [];
    for (const img of document.images) {
      const src = img.currentSrc || img.src;
      if (!src || !/^(https?:|data:image\/|blob:)/.test(src)) continue;
      if (seen.has(src)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) continue;
      if (img.naturalWidth < 120) continue;
      seen.add(src);
      const item = { url: src, w: img.naturalWidth, h: img.naturalHeight };
      if (src.startsWith('blob:')) item.thumb = makeThumb(img);
      out.push(item);
    }
    return out;
  }

  // Lazy image in a scroll div that has not loaded yet because it was never scrolled to: force loading now
  function forceEagerImages() {
    for (const i of document.images) if (i.loading === 'lazy') i.loading = 'eager';
  }

  async function listPageImages() {
    forceEagerImages();
    await Promise.all([...document.images].map(waitLoaded));
    return { images: collectImageUrls() };
  }

  // selected: list of URLs the user picked in the side panel; if absent, use all
  async function collectAndTranslateAll(selected) {
    showToast('Đang tải các ảnh trên trang...', 'info', TOAST_MS);
    let urls;
    if (Array.isArray(selected)) {
      urls = selected;
    } else {
      forceEagerImages();
      await Promise.all([...document.images].map(waitLoaded));
      urls = collectImageUrls().map((x) => x.url);
    }
    showToast(`Đang dịch ${urls.length} ảnh...`, 'info', 0);
    urls.forEach((u) => queuedKeys.add(u));
    refreshPill();
    chrome.runtime.sendMessage({ type: 'TRANSLATE_ALL', urls });
  }

  // ================= "Translate image" button: shown only while hovering over the image =================
  // A single button (Shadow DOM, so the page's CSS does not affect it). Hovering an image shows the button at the
  // top-right corner of the visible part of the image; leaving the image, scrolling, or resizing the window hides it. It does not run in the background.
  const BTN_TEXT = {
    idle: 'Dịch ảnh',
    notext: 'Không có chữ',
    waiting: 'Chờ dịch',
    loading: 'Đang dịch...',
    shown: '✓ Bản dịch',
    hidden: 'Xem bản dịch',
  };
  const BTN_MIN = 120;           // applies only to images at least 120px in each dimension
  const HIDE_DELAY = 150;        // ms to wait before hiding the button when the mouse leaves the image
  const pendingUrls = new Set(); // images being translated with the button
  let pillHost = null;
  let pill = null;               // { el, label }
  let pillRoot = null;           // shadow root containing all buttons
  let pillImg = null;            // the image the button is attached to
  let pillsEnabled = true;
  let hideTimer = null;
  let moveQueued = false;
  let lastX = -1; // -1: mouse position not known yet
  let lastY = -1;

  const ICON_SVG = '<svg viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" rx="6" fill="#4da3ff"/>' +
    '<text x="3.5" y="12.5" font-size="10" font-weight="700" fill="#fff" font-family="sans-serif">文</text>' +
    '<text x="12.5" y="19.5" font-size="10" font-weight="700" fill="#fff" font-family="sans-serif">A</text></svg>';

  const PILL_CSS = `
    .pill{position:fixed;display:none;align-items:center;gap:8px;height:34px;padding:0 14px 0 5px;border:0;
      border-radius:999px;background:#fff;color:#2a3347;font:600 14px/1 system-ui,"Segoe UI",Roboto,sans-serif;
      box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer;pointer-events:auto;white-space:nowrap;
      opacity:0;transform:scale(.6);transform-origin:top left;
      transition:opacity .18s ease,transform .18s ease,box-shadow .15s}
    .pill.on{opacity:1;transform:scale(1)}
    .pill.dl-only{width:34px;padding:0;justify-content:center;gap:0}
    .pill:hover{box-shadow:0 3px 14px rgba(0,0,0,.4)}
    .pill[data-state=loading]{cursor:progress}
    .ico{display:flex;width:24px;height:24px}
    .ico img{width:24px;height:24px;border-radius:6px}
    .pill[data-state=loading] .ico{animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .pill[data-state=shown]{background:#1f9d55;color:#fff}
    .pill[data-state=hidden]{background:#2f7df6;color:#fff}
    .pill[data-state=notext],.pill[data-state=waiting]{background:#6b7280;color:#fff;cursor:default}
    .pill[data-state=shown] .ico img,.pill[data-state=hidden] .ico img{box-shadow:0 0 0 2px #fff}
    .pill.flash{animation:flash .9s ease-out 2}
    @keyframes flash{
      0%{transform:scale(.85);box-shadow:0 0 0 0 rgba(31,157,85,.9)}
      30%{transform:scale(1.12)}
      65%{transform:scale(1);box-shadow:0 0 0 16px rgba(31,157,85,0)}
      100%{transform:scale(1);box-shadow:0 2px 10px rgba(0,0,0,.3)}}`;

  // Show/hide the button with a fade and shrink. Show: set display first, then add .on so the animation plays.
  // Hide: remove .on, then set display:none after the animation finishes.
  function setBtnShown(el, on) {
    if (!el) return;
    clearTimeout(el._hideT);
    if (on) {
      if (el._shown) return;
      el._shown = true;
      el.style.display = 'flex';
      void el.offsetWidth; // force layout before changing opacity/transform
      el.classList.add('on');
    } else {
      if (!el._shown) { el.style.display = 'none'; return; }
      el._shown = false;
      el.classList.remove('on');
      el._hideT = setTimeout(() => { if (!el._shown) el.style.display = 'none'; }, 200);
    }
  }

  function ensurePill() {
    if (pillHost && pillHost.isConnected) return pill;
    pillHost = document.createElement('div');
    pillHost.id = 'ocr-pill-host';
    pillHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483645;';
    const root = pillHost.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = PILL_CSS;
    root.appendChild(st);

    pillRoot = root;
    pill = makeButton(() => { if (pillImg) onPillClick(pillImg); });
    (document.body || document.documentElement).appendChild(pillHost);
    return pill;
  }

  // Create one button (icon + text) in the shadow root; onClick runs when it is clicked
  function makeButton(onClick) {
    const el = document.createElement('button');
    el.className = 'pill';
    el.type = 'button';
    const ico = document.createElement('span');
    ico.className = 'ico';
    const im = document.createElement('img');
    try { im.src = chrome.runtime.getURL('icons/icon48.png'); } catch (_) {}
    im.onerror = () => { ico.innerHTML = ICON_SVG; }; // no icon yet: use the fallback image
    ico.appendChild(im);
    const label = document.createElement('span');
    el.append(ico, label);
    // When the animation ends, or is cancelled because the button is hidden (display:none when the image scrolls off screen), remove the class,
    // so the animation does not replay when the button shows again: it runs only once, right after translation finishes
    for (const ev of ['animationend', 'animationcancel']) {
      el.addEventListener(ev, (e) => { if (e.animationName === 'flash') el.classList.remove('flash'); });
    }
    // Stop the event from reaching the page (avoid flipping the page or zooming the image when clicked)
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']) {
      el.addEventListener(t, (e) => e.stopPropagation());
    }
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClick();
    });
    pillRoot.appendChild(el);
    return { el, label };
  }

  // Translated image: the button stays fixed at the top-right of the visible part of the image (independent of hover),
  // even while viewing the original, so you can click it to switch back to the translation
  function ensurePin(entry) {
    if (entry.pin && entry.pin.el.isConnected) return entry.pin;
    ensurePill(); // make sure the host/shadow root exists
    entry.pin = makeButton(() => onPillClick(entry.img));
    return entry.pin;
  }

  function updatePin(entry) {
    const v = visibleRect(entry.img);
    if (pendingUrls.has(entry.srcUrl)) { // translating again: the spinning icon replaces this button
      hideTranslatedPins(entry);
      return;
    }
    if (!pillsEnabled || v.r - v.l < BTN_MIN || v.b - v.t < 40) { // image scrolled off screen or too small
      hideTranslatedPins(entry);
      return;
    }
    const pin = ensurePin(entry);
    const state = entry.hidden ? 'hidden' : 'shown';
    pin.el.dataset.state = state;
    pin.label.textContent = BTN_TEXT[state];
    pin.el.title = state === 'shown' ? 'Bấm để xem ảnh gốc' : 'Bấm để xem bản dịch';
    setBtnShown(pin.el, true);
    pin.el.style.left = v.l + 10 + 'px';
    pin.el.style.top = v.t + 10 + 'px';
    placeDownloadPin(entry, v, pin.el);
    // Just translated and the button is visible: flash exactly once. When overlayImage runs the button is still hidden
    // (pendingUrls not yet cleared), so the flash is deferred until the first updatePin where the button is actually shown.
    if (entry.flashUntil && !entry.flashed) {
      if (Date.now() <= entry.flashUntil) { entry.flashed = true; flashPin(entry); }
      else entry.flashUntil = 0; // expired (the image was off screen when translation finished): drop it, do not flash when scrolled into view
    }
  }

  // ---- Download the translated image (original + translation merged into one PNG) ----
  function hideTranslatedPins(entry) {
    if (entry.pin) setBtnShown(entry.pin.el, false);
    if (entry.dlPin) setBtnShown(entry.dlPin.el, false);
  }

  function ensureDownloadPin(entry) {
    if (entry.dlPin && entry.dlPin.el.isConnected) return entry.dlPin;
    ensurePill();
    entry.dlPin = makeButton(() => downloadTranslatedImage(entry));
    entry.dlPin.el.dataset.state = 'download';
    entry.dlPin.el.classList.add('dl-only'); // icon only, no text
    entry.dlPin.el.title = 'Tải ảnh đã dịch về máy';
    entry.dlPin.el.querySelector('.ico').innerHTML =
      '<svg viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" rx="6" fill="#2a3347"/>' +
      '<path d="M12 5v9m0 0-4-4m4 4 4-4M6 18h12" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return entry.dlPin;
  }

  // Right of the translate button, on the same row (top-left of the visible image)
  function placeDownloadPin(entry, v, pinEl) {
    const dl = ensureDownloadPin(entry);
    setBtnShown(dl.el, true);
    dl.el.style.left = v.l + 10 + pinEl.offsetWidth + 8 + 'px';
    dl.el.style.top = v.t + 10 + 'px';
  }

  // Use the original pixels: the page image itself if it is not cross-origin, otherwise ask the background to fetch it
  async function loadSourceImage(entry) {
    const img = entry.img;
    try {
      const t = document.createElement('canvas');
      t.width = 1; t.height = 1;
      const tc = t.getContext('2d');
      tc.drawImage(img, 0, 0, 1, 1);
      tc.getImageData(0, 0, 1, 1); // throws SecurityError when the canvas is tainted
      return img;
    } catch (_) { /* cross-origin image: fetch it through the background */ }
    const r = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: entry.srcUrl }).catch(() => null);
    if (!r || !r.dataUrl) throw new Error('Không tải được ảnh gốc');
    const im = new Image();
    im.src = r.dataUrl;
    await im.decode();
    return im;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Draw one translated box with the same geometry as layoutOverlay (its position and size are in layer px, scaled by k)
  function drawTextBox(ctx, box, k) {
    const x = parseFloat(box.style.left) * k, y = parseFloat(box.style.top) * k;
    const w = parseFloat(box.style.width) * k, h = parseFloat(box.style.height) * k;
    const fs = parseFloat(box.style.fontSize) * k;
    ctx.save();
    ctx.fillStyle = box.style.backgroundColor || '#fff';
    ctx.beginPath();
    if (box.style.borderRadius === '50%') {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      const r = Math.min(parseFloat(box.style.borderRadius) * k || 0, w / 2, h / 2);
      roundRectPath(ctx, x, y, w, h, r);
    }
    ctx.fill();
    ctx.fillStyle = box.style.color || '#000';
    ctx.font = `${box.style.fontStyle} ${box.style.fontWeight} ${fs}px ${box.style.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = box.textContent.split('\n');
    const lh = fs * LINE_H;
    const startY = y + h / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, x + w / 2, startY + i * lh));
    ctx.restore();
  }

  async function renderTranslatedImage(entry) {
    const W = entry.width, H = entry.height;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(await loadSourceImage(entry), 0, 0, W, H);
    // Text boxes are laid out in the layer's display px; scale to the original image's pixels
    const layerW = parseFloat(entry.layer.style.width) || entry.img.getBoundingClientRect().width;
    const k = W / layerW;
    for (const box of entry.layer.children) if (box.dataset.idx !== undefined) drawTextBox(ctx, box, k);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Không tạo được ảnh'))), 'image/png'));
  }

  async function downloadTranslatedImage(entry) {
    const el = entry.dlPin && entry.dlPin.el;
    if (el) el.dataset.state = 'loading';
    try {
      const blob = await renderTranslatedImage(entry);
      let base = 'anh';
      try { base = new URL(entry.srcUrl, location.href).pathname.split('/').pop().replace(/\.[^.]+$/, '') || base; } catch (_) {}
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = base + '_ban-dich.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (err) {
      console.error('[OCR] tải ảnh đã dịch lỗi:', err);
    } finally {
      if (el) el.dataset.state = 'download';
    }
  }

  // Just translated: the button flashes and bounces a few times to get attention, then stays still
  function flashPin(entry) {
    const el = entry.pin && entry.pin.el;
    if (!el || !el._shown) return;
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }

  function imgKey(img) { return img.currentSrc || img.src; }

  // Image being translated with the button: keep the button (spinning icon) fixed at the top-right of the visible part of the image,
  // independent of hover, until translation finishes (the fixed translation button replaces it) or an error occurs.
  const pendingPins = new Map(); // srcUrl -> { img, btn }

  function addPendingPin(key, img) {
    removePendingPin(key);
    ensurePill();
    const btn = makeButton(() => {});
    btn.el.dataset.state = 'loading';
    btn.label.textContent = BTN_TEXT.loading;
    pendingPins.set(key, { img, btn });
    updatePendingPin(key);
    startPolling();
  }

  function removePendingPin(key) {
    const p = pendingPins.get(key);
    if (!p) return;
    p.btn.el.remove();
    pendingPins.delete(key);
  }

  function updatePendingPin(key) {
    const p = pendingPins.get(key);
    if (!p) return;
    if (!p.img.isConnected) { // page rebuilt the <img>: find it again by URL
      const again = findImage(key);
      if (again) p.img = again;
    }
    const v = p.img.isConnected ? visibleRect(p.img) : null;
    if (!pillsEnabled || !v || v.r - v.l < BTN_MIN || v.b - v.t < 40) { // off screen: hide temporarily; it shows again when scrolled back
      setBtnShown(p.btn.el, false);
      return;
    }
    setBtnShown(p.btn.el, true);
    p.btn.el.style.left = v.l + 10 + 'px';
    p.btn.el.style.top = v.t + 10 + 'px';
  }

  function updateAllPendingPins() {
    for (const key of [...pendingPins.keys()]) updatePendingPin(key);
  }

  function pillState(key) {
    if (queuedKeys.has(key)) return 'waiting';
    if (noTextKeys.has(key)) return 'notext';
    if (pendingUrls.has(key)) return 'loading';
    const e = overlayEntries.get(key);
    if (!e) return 'idle';
    return e.hidden ? 'hidden' : 'shown';
  }

  // Update the button's text/state according to the attached image (position is not changed)
  function refreshPill() {
    if (!pill || !pillImg) return;
    const state = pillState(imgKey(pillImg));
    pill.el.dataset.state = state;
    pill.label.textContent = BTN_TEXT[state];
    pill.el.title = state === 'idle' ? 'Dịch chữ trong ảnh này bằng Gemini' : '';
  }

  function onPillClick(img) {
    const key = imgKey(img);
    if (!key || pendingUrls.has(key) || noTextKeys.has(key) || queuedKeys.has(key)) return;
    const entry = overlayEntries.get(key);
    if (entry) { // translated: click to toggle between the original and the translation
      entry.hidden = !entry.hidden;
      entry.layer.style.display = entry.hidden ? 'none' : 'block';
      updatePin(entry);
      refreshPill();
      return;
    }
    startTranslate(img, key);
  }

  // Right-click "translate this image": works exactly like the button on the image (spinning icon on the image, does not open the bottom-right panel).
  // If the image already has a translation, do not translate it again. Returns false if no <img> is found
  // (e.g. CSS background image, image inside an iframe) so the background falls back to the old method.
  function translateFromMenu(srcUrl) {
    const img = findImage(srcUrl);
    if (!img) return false;
    const key = imgKey(img);
    if (!key) return false;
    const entry = overlayEntries.get(key);
    if (entry) { // already translated: do not translate again; if viewing the original, turn the translation back on
      if (entry.hidden) {
        entry.hidden = false;
        entry.layer.style.display = 'block';
        updatePin(entry);
      }
      return true;
    }
    if (!pendingUrls.has(key)) startTranslate(img, key);
    return true;
  }

  function startTranslate(img, key) {
    pendingUrls.add(key);
    addPendingPin(key, img);
    hidePill(); // the hover button yields to the spinning fixed button
    const done = () => {
      pendingUrls.delete(key); removePendingPin(key); refreshPill();
      const e = overlayEntries.get(key);
      if (e) updatePin(e); // show the translation button (and flash) immediately instead of waiting for the periodic check
    };
    try {
      chrome.runtime.sendMessage({ type: 'TRANSLATE_ONE', srcUrl: key }, () => {
        void chrome.runtime.lastError;
        done();
      });
    } catch (_) {
      done(); // the extension was just reloaded: a page refresh (F5) is needed
    }
  }

  // The visible part of the image: intersection of the image, the viewport, and the scroll/clip divs containing it
  function visibleRect(img) {
    const r = img.getBoundingClientRect();
    let l = Math.max(r.left, 0), t = Math.max(r.top, 0);
    let rt = Math.min(r.right, window.innerWidth), b = Math.min(r.bottom, window.innerHeight);
    for (let el = img.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (rt <= l || b <= t) break;
      const cs = getComputedStyle(el);
      if (!isClipping(cs.overflowX) && !isClipping(cs.overflowY)) continue;
      const hr = el.getBoundingClientRect();
      l = Math.max(l, hr.left); t = Math.max(t, hr.top);
      rt = Math.min(rt, hr.right); b = Math.min(b, hr.bottom);
    }
    return { l, t, r: rt, b };
  }

  // image known to have no text (reported by background): do not show the translate button
  const noTextKeys = new Set();
  const queuedKeys = new Set(); // images added to a multi-image run but not yet drawn

  function markNoText(key) {
    if (!key) return;
    noTextKeys.add(key);
    if (pillImg && imgKey(pillImg) === key) refreshPill();
  }

  // On page load: ask background for the list of known no-text images for this tab
  try {
    chrome.runtime.sendMessage({ type: 'GET_NOTEXT' }, (res) => {
      void chrome.runtime.lastError;
      for (const u of (res && res.urls) || []) noTextKeys.add(u);
    });
  } catch (_) {}

  function eligible(img) {
    const key = imgKey(img);
    if (!key || !/^(https?:|data:image\/|blob:)/.test(key)) return false;
    const r = img.getBoundingClientRect();
    return r.width >= BTN_MIN && r.height >= BTN_MIN && img.naturalWidth >= BTN_MIN;
  }

  function showPillFor(img) {
    const p = ensurePill();
    pillImg = img;
    refreshPill();
    // Position is recalculated each time it is placed, so the button follows the image while scrolling
    const place = () => {
      const v = visibleRect(img);
      if (v.r - v.l < BTN_MIN || v.b - v.t < 40) return false;
      p.el.style.left = v.l + 10 + 'px';
      p.el.style.top = v.t + 10 + 'px';
      return true;
    };
    const v = visibleRect(img);
    if (v.r - v.l < BTN_MIN || v.b - v.t < 40) { hidePill(); return; }
    // currently showing this image: only follow its position
    if (p._target === img && p.el._shown) { place(); return; }
    // waiting to switch to this image: set a timer to handle it
    if (p._target === img && p._switchT) return;
    const wasShown = p.el._shown;
    p._target = img;
    clearTimeout(p._switchT);
    p._switchT = null;
    if (wasShown) {
      // Switching to another image: shrink and fade the button on the old image, then show it again (with animation) on the new image
      setBtnShown(p.el, false);
      p._switchT = setTimeout(() => {
        p._switchT = null;
        if (pillImg !== img) return;
        // the button must be shown before its position is set: when hidden, offsetWidth = 0 and the button would be pushed outside the image
        setBtnShown(p.el, true);
        if (!place()) setBtnShown(p.el, false);
      }, 200);
      return;
    }
    setBtnShown(p.el, true);
    place();
  }
  function hidePill() {
    clearTimeout(hideTimer);
    hideTimer = null;
    pillImg = null;
    if (pill) { clearTimeout(pill._switchT); pill._switchT = null; pill._target = null; }
    if (pill) setBtnShown(pill.el, false);
  }

  // Find a large enough <img> under the cursor (even when covered by a transparent layer of the page)
  function imgAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === pillHost) continue;
      if (el instanceof HTMLImageElement) return eligible(el) ? el : null;
    }
    return null;
  }

  function onMove(force) {
    if (force !== true) moveQueued = false;
    if (!pillsEnabled || lastX < 0) return;
    let img = imgAt(lastX, lastY);
    if (img && (overlayEntries.has(imgKey(img)) || pendingUrls.has(imgKey(img)))) img = null; // already translated / being translated: it has a fixed button
    if (img) {
      clearTimeout(hideTimer);
      hideTimer = null;
      if (force === true || img !== pillImg) showPillFor(img);
    } else if (pillImg && !hideTimer) {
      hideTimer = setTimeout(hidePill, HIDE_DELAY);
    }
  }

  document.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => onMove());
  }, { capture: true, passive: true });
  document.addEventListener('mouseleave', () => { if (pillImg && !hideTimer) hideTimer = setTimeout(hidePill, HIDE_DELAY); });
  // The button does not follow while scrolling: hide it; hover again to show it at the new position
  // While scrolling: the button stays on the image under the cursor and only moves with the top-right corner of the visible part
  // (if another image scrolls under the cursor, the button moves to that image)
  let scrollQueued = false;
  function onLayoutChange() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; onMove(true); });
  }
  window.addEventListener('scroll', onLayoutChange, true);
  window.addEventListener('resize', onLayoutChange);

  // Allow turning the button off: chrome.storage.sync { showImageButton: false }
  try {
    chrome.storage.sync.get({ showImageButton: true }).then((s) => { pillsEnabled = s.showImageButton !== false; });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.showImageButton) {
        pillsEnabled = ch.showImageButton.newValue !== false;
        if (!pillsEnabled) hidePill();
        layoutAllOverlays();
      }
    });
  } catch (_) {}

  // ================= Floating button on the right side, vertically centered =================
  // Click: opens the side panel (image list) like the toolbar icon; click again to close it.
  // Can be turned off with: chrome.storage.sync { showSideButton: false }
  const DOCK_CSS = `
    .dock{position:fixed;right:0;top:50%;width:46px;height:48px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
      padding:0 10px 0 6px;border:0;outline:0;border-radius:12px 0 0 12px;background:#fff;
      box-shadow:-2px 2px 10px rgba(0,0,0,.28);cursor:pointer;pointer-events:auto;
      transform:translate(8px,-50%);opacity:.92;
      transition:transform .18s ease,opacity .18s ease,box-shadow .15s,background .15s}
    .dock:hover,.dock.open{transform:translate(0,-50%);opacity:1;box-shadow:-3px 3px 14px rgba(0,0,0,.4)}
    .dock:active{background:#eef3fb}
    .dock:focus{outline:0}
    .dock img,.dock svg{width:28px;height:28px;border-radius:7px;display:block;flex:none}`;
  let dockHost = null;
  let dockBtn = null;
  let dockEnabled = true;
  let panelOpen = false; // side panel is open: the button keeps its position as when hovered

  const PAGE_PANEL_W = 380; // width (px) of the in-page panel
  function setDockOpen(on) {
    panelOpen = !!on;
    if (dockBtn) {
      dockBtn.classList.toggle('open', panelOpen);
      dockBtn.style.right = panelOpen ? PAGE_PANEL_W + 'px' : '0';
    }
  }

  // ================= In-page panel (a div on the right of the page, same content as the side panel / popup.html) =================
  // popup.html is loaded in an iframe inside the div, so its CSS and JS stay isolated from the page and keep working unchanged.
  let pagePanelHost = null;
  let pagePanelBox = null;

  function ensurePagePanel() {
    if (pagePanelHost && pagePanelHost.isConnected) return;
    pagePanelHost = document.createElement('div');
    pagePanelHost.id = 'ocr-page-panel-host';
    pagePanelHost.style.cssText = 'all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483645;';
    const root = pagePanelHost.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = `
      .box{position:fixed;top:0;right:0;width:${PAGE_PANEL_W}px;max-width:100vw;height:100vh;background:#282c34;
        box-shadow:-4px 0 18px rgba(0,0,0,.35);transform:translateX(100%);visibility:hidden;
        transition:transform .22s ease,visibility 0s linear .22s}
      .box.show{transform:none;visibility:visible;transition:transform .22s ease,visibility 0s}
      iframe{display:block;width:100%;height:100%;border:0;background:#282c34}
      @media (prefers-reduced-motion:reduce){.box,.box.show{transition:none}}`;
    root.appendChild(st);
    const box = document.createElement('div');
    box.className = 'box';
    const frame = document.createElement('iframe');
    frame.title = 'AI Image Translate';
    // Load lazily the first time the panel is opened
    frame.dataset.src = chrome.runtime.getURL('popup.html');
    box.appendChild(frame);
    // Do not let events reach the page
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel']) {
      box.addEventListener(t, (e) => e.stopPropagation());
    }
    root.appendChild(box);
    pagePanelBox = box;
    (document.body || document.documentElement).appendChild(pagePanelHost);
  }

  function togglePagePanel(force) {
    ensurePagePanel();
    const show = typeof force === 'boolean' ? force : !pagePanelBox.classList.contains('show');
    const frame = pagePanelBox.querySelector('iframe');
    if (show && !frame.src) frame.src = frame.dataset.src;
    // Next frame, so the slide-in transition also runs the first time
    requestAnimationFrame(() => pagePanelBox.classList.toggle('show', show));
    setDockOpen(show);
  }

  // Esc closes the panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) togglePagePanel(false);
  }, true);

  // Click outside the panel (on the page) closes it. Clicks inside the panel (its iframe) never reach this document,
  // and the dock button toggles by itself, so both are ignored here.
  document.addEventListener('pointerdown', (e) => {
    if (!panelOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(pagePanelHost) || path.includes(dockHost)) return;
    togglePagePanel(false);
  }, true);

  function ensureDock() {
    if (dockHost && dockHost.isConnected) return;
    dockHost = document.createElement('div');
    dockHost.id = 'ocr-dock-host';
    dockHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483644;';
    const root = dockHost.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = DOCK_CSS;
    root.appendChild(st);

    const btn = document.createElement('button');
    btn.className = 'dock';
    btn.type = 'button';
    btn.title = 'Mở / đóng danh sách ảnh';
    const im = document.createElement('img');
    try { im.src = chrome.runtime.getURL('icons/icon48.png'); } catch (_) {}
    im.onerror = () => { im.remove(); btn.insertAdjacentHTML('afterbegin', ICON_SVG.replace('width="24" height="24"', 'width="28" height="28"')); };
    btn.appendChild(im);
    // Do not let the event reach the page
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']) {
      btn.addEventListener(t, (e) => e.stopPropagation());
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      togglePagePanel();
    });
    root.appendChild(btn);
    dockBtn = btn;
    btn.classList.toggle('open', panelOpen);
    (document.body || document.documentElement).appendChild(dockHost);
  }

  function updateDock() {
    if (dockEnabled) ensureDock();
    else if (dockHost) { dockHost.remove(); dockHost = null; dockBtn = null; }
  }

  try {
    chrome.storage.sync.get({ showSideButton: true }).then((s) => {
      dockEnabled = s.showSideButton !== false;
      updateDock();
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.showSideButton) {
        dockEnabled = ch.showSideButton.newValue !== false;
        updateDock();
      }
    });
  } catch (_) { updateDock(); }

  function removePanel() {
    panel?.remove();
    panel = null;
  }
})();
