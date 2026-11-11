(() => {
  if (window.__ocrTranslateInjected) return;
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
      case 'PANEL_STATE':     setDockOpen(msg.open); break;
      case 'NOTEXT':          markNoText(msg.srcUrl); break;
      case 'MENU_TRANSLATE':  sendResponse({ handled: translateFromMenu(msg.srcUrl) }); break;
      case 'FETCH_BLOB':
        blobUrlToDataUrl(msg.url).then((dataUrl) => sendResponse({ dataUrl }), (err) => sendResponse({ error: String(err && err.message || err) }));
        return true;
    }
  });

  // ---------- Watch for image changes on the page -> tell the side panel to refresh its list ----------
  const OWN_SELECTOR = '#ocr-pill-host, #ocr-dock-host, .ocr-img-overlay, #ocr-panel, #ocr-toast';
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
  const FONT_FAMILY = 'system-ui, "Segoe UI", Roboto, sans-serif';
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
  const LINE_H = 1.0; // line spacing; leaves room for Vietnamese diacritics so they are not clipped
  const MIN_FONT = 9; // hard floor: below this size the text is unreadable

  // maxSize: maximum font size based on the original text in the image (may be absent)
  function fitText(div, text, w, h, maxSize) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    let size = Math.max(MIN_FONT, Math.floor(h * 0.8));
    if (maxSize) size = Math.max(MIN_FONT, Math.min(size, Math.floor(maxSize)));
    let lines = [];
    let fitted = false;
    for (; size >= MIN_FONT; size--) {
      measureCtx.font = `${size}px ${FONT_FAMILY}`;
      lines = wrapWords(text, w);
      const fitsHeight = lines.length * size * LINE_H <= h + 1;
      const fitsWidth = lines.every((l) => measureCtx.measureText(l).width <= w + 1);
      if (fitsHeight && fitsWidth) { fitted = true; break; }
    }
    if (!fitted) size = MIN_FONT; // really does not fit: use the smallest size and accept a slight overflow
    measureCtx.font = `${size}px ${FONT_FAMILY}`;
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

  function removeEntry(entry) {
    layoutObserver.unobserve(entry.img);
    entry.layer.remove();
    if (entry.pin) { entry.pin.el.remove(); entry.pin = null; }
    overlayEntries.delete(entry.srcUrl);
    releaseHost(entry.host);
  }

  function aspectOf(im) {
    if (im.naturalWidth > 0) return im.naturalWidth / im.naturalHeight;
    const r = im.getBoundingClientRect();
    return r.width / Math.max(1, r.height);
  }

  // List of <img> in DOM order inside the scroll container (or the whole page if the image is not inside a scroll div)
  function imagesIn(container) {
    return container === document ? [...document.images] : [...container.querySelectorAll('img')];
  }

  // Record which index the translated image has within its scroll container
  function snapshotEntry(entry) {
    const im = entry.img;
    entry.cont = findScrollHost(im) || document;
    entry.ord = imagesIn(entry.cont).indexOf(im);
  }

  // Find a replacement image: take the image with the same index in the scroll container (e.g. if image 5 was translated, take image 5).
  // If that image has no translation yet or has a different aspect ratio (off by more than 5%), return null: hide temporarily and retry, do not guess another image.
  function findByPosition(entry) {
    if (!(entry.ord >= 0)) return null;
    const cont = entry.cont && (entry.cont === document || entry.cont.isConnected) ? entry.cont : document;
    const cand = imagesIn(cont)[entry.ord];
    if (!cand || !cand.isConnected) return null;
    for (const e of overlayEntries.values()) if (e !== entry && e.img === cand) return null; // already has another translation attached
    const aspectOld = entry.width / entry.height;
    return Math.abs(aspectOf(cand) / aspectOld - 1) <= 0.05 ? cand : null;
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
      // (if the old URL is gone, find the image by position and size, then store the new URL in the translation)
      const again = findImage(entry.srcUrl) || findByPosition(entry);
      if (again && again.isConnected && rebindEntry(entry, again)) {
        img = entry.img;
      } else {
        if (overlayEntries.get(entry.srcUrl) === entry) { // not removed for aspect-ratio reasons: hide temporarily and retry later
          layer.style.display = 'none';
          if (entry.pin) setBtnShown(entry.pin.el, false);
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
    snapshotEntry(entry);

    layer.textContent = '';
    const pad = 2;
    for (const it of items) {
      if (!it.translated) continue;
      const ellipse = it.shape === 'ellipse';
      // Round bubble/oval: shrink by 1% so the original outline is still visible; the text box is taken from inside the ellipse
      const inset = ellipse ? 0.01 : 0;
      const bw = (it.box.x1 - it.box.x0) * sx;
      const bh = (it.box.y1 - it.box.y0) * sy;
      const x = it.box.x0 * sx + (ellipse ? bw * inset : -pad);
      const y = it.box.y0 * sy + (ellipse ? bh * inset : -pad);
      const w = ellipse ? bw * (1 - 2 * inset) : bw + 2 * pad;
      const h = ellipse ? bh * (1 - 2 * inset) : bh + 2 * pad;
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
      // Original font size from Gemini as a cap (never larger than the original text); if absent, use the measured line spacing
      const cap = it.fontPx ? it.fontPx * sy : it.linePx ? it.linePx * sy * FONT_CAP : 0;
      fitText(div, it.translated, tw, th, cap);
    }
  }

  function layoutAllOverlays() {
    for (const entry of [...overlayEntries.values()]) layoutOverlay(entry);
    updateAllPendingPins();
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
      opacity:0;transform:scale(.6);transform-origin:top right;
      transition:opacity .18s ease,transform .18s ease,box-shadow .15s}
    .pill.on{opacity:1;transform:scale(1)}
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
      if (entry.pin) setBtnShown(entry.pin.el, false);
      return;
    }
    if (!pillsEnabled || v.r - v.l < BTN_MIN || v.b - v.t < 40) { // image scrolled off screen or too small
      if (entry.pin) setBtnShown(entry.pin.el, false);
      return;
    }
    const pin = ensurePin(entry);
    const state = entry.hidden ? 'hidden' : 'shown';
    pin.el.dataset.state = state;
    pin.label.textContent = BTN_TEXT[state];
    pin.el.title = state === 'shown' ? 'Bấm để xem ảnh gốc' : 'Bấm để xem bản dịch';
    setBtnShown(pin.el, true);
    pin.el.style.left = Math.max(v.l, v.r - pin.el.offsetWidth - 10) + 'px';
    pin.el.style.top = v.t + 10 + 'px';
    // Just translated and the button is visible: flash exactly once. When overlayImage runs the button is still hidden
    // (pendingUrls not yet cleared), so the flash is deferred until the first updatePin where the button is actually shown.
    if (entry.flashUntil && !entry.flashed) {
      if (Date.now() <= entry.flashUntil) { entry.flashed = true; flashPin(entry); }
      else entry.flashUntil = 0; // expired (the image was off screen when translation finished): drop it, do not flash when scrolled into view
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
    p.btn.el.style.left = Math.max(v.l, v.r - p.btn.el.offsetWidth - 10) + 'px';
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
      p.el.style.left = Math.max(v.l, v.r - p.el.offsetWidth - 10) + 'px';
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

  function setDockOpen(on) {
    panelOpen = !!on;
    if (dockBtn) dockBtn.classList.toggle('open', panelOpen);
  }

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
      try { chrome.runtime.sendMessage({ type: 'TOGGLE_SIDE_PANEL' }).catch(() => {}); } catch (_) {}
    });
    root.appendChild(btn);
    dockBtn = btn;
    btn.classList.toggle('open', panelOpen);
    (document.body || document.documentElement).appendChild(dockHost);
    try {
      chrome.runtime.sendMessage({ type: 'GET_PANEL_STATE' }).then((r) => setDockOpen(r && r.open)).catch(() => {});
    } catch (_) {}
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
