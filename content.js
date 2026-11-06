(() => {
  if (window.__ocrTranslateInjected) return;
  window.__ocrTranslateInjected = true;

  let overlay = null;
  let box = null;
  let panel = null;
  let startX = 0;
  let startY = 0;

  // Ctrl+C+C (Cmd+C+C trên Mac): nhấn Copy hai lần trong 500ms để bật chọn vùng
  let lastCopyTime = 0;
  document.addEventListener('keydown', (e) => {
    const isCopy = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
                   (e.key === 'c' || e.key === 'C');
    if (!isCopy || e.repeat) return;
    const now = Date.now();
    if (now - lastCopyTime < 500) {
      lastCopyTime = 0;
      startSelection();
    } else {
      lastCopyTime = now;
    }
  }, true);

  // Ghi nhớ ảnh vừa chuột phải để biết phủ bản dịch lên đúng thẻ <img>
  let lastContextImg = null;
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    lastContextImg = t instanceof Element ? (t.closest('img') || null) : null;
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'LIST_IMAGES':     listPageImages().then(sendResponse); return true;
      case 'START_SELECTION': startSelection(); break;
      case 'SHOW_LOADING':    showPanel('Đang nhận dạng và dịch...', null); break;
      case 'SHOW_RESULT':     showPanel(msg.translated, msg.original); break;
      case 'SHOW_ERROR':      showPanel('⚠ ' + msg.error, null); break;
      case 'HIDE_PANEL':      removePanel(); break;
      case 'OVERLAY_IMAGE':   overlayImage(msg); break;
      case 'TRANSLATE_ALL_START': collectAndTranslateAll(msg.urls); break;
      case 'SHOW_INFO':       showPanel(msg.text, null); break;
      case 'FETCH_BLOB':
        blobUrlToDataUrl(msg.url).then((dataUrl) => sendResponse({ dataUrl }), (err) => sendResponse({ error: String(err && err.message || err) }));
        return true;
    }
  });

  function startSelection() {
    removePanel();
    cleanupSelection();

    overlay = document.createElement('div');
    overlay.id = 'ocr-overlay';
    overlay.innerHTML = '<div class="ocr-hint">Kéo chuột để chọn vùng chữ · Esc để hủy</div>';

    box = document.createElement('div');
    box.className = 'ocr-box';
    box.style.display = 'none';
    overlay.appendChild(box);

    overlay.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(overlay);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    box.style.display = 'block';
    updateBox(e.clientX, e.clientY);
    overlay.addEventListener('mousemove', onMouseMove);
    overlay.addEventListener('mouseup', onMouseUp, { once: true });
  }

  function onMouseMove(e) {
    updateBox(e.clientX, e.clientY);
  }

  function updateBox(x, y) {
    Object.assign(box.style, {
      left: Math.min(startX, x) + 'px',
      top: Math.min(startY, y) + 'px',
      width: Math.abs(x - startX) + 'px',
      height: Math.abs(y - startY) + 'px',
    });
  }

  function onMouseUp(e) {
    const rect = {
      x: Math.min(startX, e.clientX),
      y: Math.min(startY, e.clientY),
      w: Math.abs(e.clientX - startX),
      h: Math.abs(e.clientY - startY),
    };
    cleanupSelection();
    if (rect.w < 10 || rect.h < 10) return;

    // Đợi overlay được gỡ khỏi màn hình rồi mới chụp
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chrome.runtime.sendMessage({ type: 'CAPTURE', rect, dpr: window.devicePixelRatio });
    }));
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') cleanupSelection();
  }

  function cleanupSelection() {
    document.removeEventListener('keydown', onKeyDown, true);
    overlay?.remove();
    overlay = null;
    box = null;
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

  // Chỉ trả về <img> có đúng địa chỉ ảnh. Không đoán bằng ảnh chuột phải gần nhất,
  // vì như vậy bản dịch của ảnh khác sẽ bị phủ nhầm lên ảnh không được dịch
  function findImage(srcUrl) {
    if (lastContextImg && (lastContextImg.currentSrc === srcUrl || lastContextImg.src === srcUrl)) {
      return lastContextImg;
    }
    return [...document.images].find((i) => i.currentSrc === srcUrl || i.src === srcUrl) || null;
  }

  // Đo bằng canvas: ngắt dòng theo độ rộng khung, rồi chọn cỡ chữ lớn nhất vừa khung
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

  // Hệ số cỡ chữ dịch so với bước dòng của chữ gốc (chỉnh nếu thấy chữ dịch to/nhỏ hơn chữ gốc)
  const FONT_CAP = 0.8;
  const LINE_H = 1.0; // khoảng dòng; giữ đủ chỗ cho dấu tiếng Việt, tránh bị cắt
  const MIN_FONT = 24; // cỡ chữ nhỏ nhất của bản dịch (px)

  // maxSize: cỡ chữ tối đa theo chữ gốc trên hình (có thể không có)
  function fitText(div, text, w, h, maxSize) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    let size = Math.max(MIN_FONT, Math.floor(h * 0.8));
    if (maxSize) size = Math.max(MIN_FONT, Math.min(size, Math.floor(maxSize)));
    let lines = [];
    for (; size >= MIN_FONT; size--) {
      measureCtx.font = `${size}px ${FONT_FAMILY}`;
      lines = wrapWords(text, w);
      const fitsHeight = lines.length * size * LINE_H <= h + 1;
      const fitsWidth = lines.every((l) => measureCtx.measureText(l).width <= w + 1);
      if (fitsHeight && fitsWidth) break;
    }
    if (size < MIN_FONT) {
      size = MIN_FONT;
      measureCtx.font = `${size}px ${FONT_FAMILY}`;
      lines = wrapWords(text, w);
    }
    div.style.fontSize = size + 'px';
    div.style.lineHeight = String(LINE_H);
    div.style.whiteSpace = 'pre';
    div.style.textAlign = 'center';
    div.textContent = lines.join('\n');
  }

  // Các lớp bản dịch đang hiển thị. Mỗi lớp được canh lại theo <img> hiện tại
  // mỗi khi bố cục trang thay đổi (ảnh khác tải xong, đổi kích thước), nên không bị lệch khi trang dịch chuyển.
  const overlayEntries = new Map();
  let layoutQueued = false;

  // ---- Ảnh nằm trong div có cuộn riêng ----
  // Lớp bản dịch được đặt NGAY TRONG div cuộn đó (toạ độ theo div), nên cuộn cùng nội dung
  // và bị div cắt đúng như ảnh. Ảnh nằm thẳng trên trang thì vẫn gắn vào <body> như trước.
  const hostPosition = new WeakMap(); // div cuộn -> giá trị position inline gốc (để khôi phục)

  function isClipping(v) {
    return v === 'auto' || v === 'scroll' || v === 'overlay' || v === 'hidden' || v === 'clip';
  }

  // Tìm div cuộn (hoặc cắt nội dung) gần nhất thực sự chứa ảnh tràn ra; null nếu ảnh nằm thẳng trên trang
  function findScrollHost(img) {
    const htmlClips = isClipping(getComputedStyle(document.documentElement).overflowY);
    for (let el = img.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      if (el === document.body && !htmlClips) break; // body cuộn theo cửa sổ: xử lý như ảnh thường
      const cs = getComputedStyle(el);
      if (!isClipping(cs.overflowX) && !isClipping(cs.overflowY)) continue;
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) return el;
    }
    return null;
  }

  // Lớp tuyệt đối chỉ cuộn theo div khi div là khối chứa; nếu div đang static thì tạm đặt relative
  function ensurePositioned(host) {
    if (getComputedStyle(host).position !== 'static') return;
    if (!hostPosition.has(host)) hostPosition.set(host, host.style.position);
    host.style.position = 'relative';
  }

  function releaseHost(host) {
    if (!host || !hostPosition.has(host)) return;
    for (const e of overlayEntries.values()) if (e.host === host) return; // còn ảnh khác dùng
    host.style.position = hostPosition.get(host);
    hostPosition.delete(host);
  }

  function removeEntry(entry) {
    layoutObserver.unobserve(entry.img);
    entry.layer.remove();
    overlayEntries.delete(entry.srcUrl);
    releaseHost(entry.host);
  }

  function layoutOverlay(entry) {
    const { img, layer, width, height, items } = entry;
    if (!img.isConnected) {
      removeEntry(entry);
      return;
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
      parent.appendChild(layer); // cũng chạy lại khi trang dựng lại DOM và làm mất lớp
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
      display: rect.width < 1 || rect.height < 1 ? 'none' : 'block',
      left: left + 'px',
      top: top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });

    // Chỉ dựng lại chữ khi kích thước ảnh đổi; chỉ cuộn hoặc dịch chỗ thì chỉ cần dời lớp
    const sizeKey = rect.width.toFixed(1) + 'x' + rect.height.toFixed(1);
    if (entry.sizeKey === sizeKey) return;
    entry.sizeKey = sizeKey;

    layer.textContent = '';
    const pad = 2;
    for (const it of items) {
      if (!it.translated) continue;
      const ellipse = it.shape === 'ellipse';
      // Bong bóng tròn/oval: thu nhẹ 1% để còn thấy viền gốc; khung chữ nhận ở vùng trong elip
      const inset = ellipse ? 0.01 : 0;
      const bw = (it.box.x1 - it.box.x0) * sx;
      const bh = (it.box.y1 - it.box.y0) * sy;
      const x = it.box.x0 * sx + (ellipse ? bw * inset : -pad);
      const y = it.box.y0 * sy + (ellipse ? bh * inset : -pad);
      const w = ellipse ? bw * (1 - 2 * inset) : bw + 2 * pad;
      const h = ellipse ? bh * (1 - 2 * inset) : bh + 2 * pad;
      if (w < 6 || h < 6) continue;
      // Vùng chữ: elip chỉ dùng phần chữ nhật nằm trong elip (~70%); khung chữ nhật chừa lề đều 7%
      // (tối thiểu 6px) để chữ không sát hoặc bị cắt ở mép
      const k = ellipse ? 0.7 : 1;
      const mx = ellipse ? (w - w * k) / 2 : Math.max(6, Math.min(w, h) * 0.07);
      const my = ellipse ? (h - h * k) / 2 : Math.max(6, Math.min(w, h) * 0.07);
      const tw = w - 2 * mx;
      const th = h - 2 * my;
      // Bo góc cho khung chữ nhật (theo cạnh ngắn, tối đa 28px)
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
        overflow: 'visible', // cỡ chữ tối thiểu 24px: cho tràn khung thay vì cắt mất chữ
        lineHeight: String(LINE_H),
        fontFamily: FONT_FAMILY,
        boxSizing: 'border-box',
        borderRadius: radius,
        padding: `${my}px ${mx}px`,
      });
      layer.appendChild(div);
      // Cỡ chữ gốc từ Gemini làm trần (không to hơn chữ gốc); không có thì dùng khoảng dòng đo được
      const cap = it.fontPx ? it.fontPx * sy : it.linePx ? it.linePx * sy * FONT_CAP : 0;
      fitText(div, it.translated, tw, th, cap);
    }
  }

  function layoutAllOverlays() {
    for (const entry of [...overlayEntries.values()]) layoutOverlay(entry);
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
  // Cuộn ở bất kỳ div nào (scroll không nổi bọt nên bắt ở giai đoạn capture)
  window.addEventListener('scroll', scheduleLayout, true);

  // Ảnh phía trên tải xong làm ảnh bên dưới dịch chỗ mà ảnh đó không đổi kích thước: kiểm tra định kỳ
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!overlayEntries.size) {
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      scheduleLayout();
    }, 400);
  }

  function overlayImage({ srcUrl, width, height, items }) {
    const img = findImage(srcUrl);
    if (!img) {
      console.warn('[OCR] không tìm thấy <img> cho', srcUrl);
      return;
    }
    // Chỉ thay bản dịch của đúng ảnh này, giữ bản dịch các ảnh khác
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

    // layoutOverlay tự gắn lớp vào đúng chỗ (body hoặc div cuộn chứa ảnh)
    const entry = { srcUrl, img, layer, width, height, items, host: undefined, sizeKey: '' };
    overlayEntries.set(srcUrl, entry);
    layoutObserver.observe(img);
    layoutOverlay(entry);
    startPolling();
  }

  // Chờ một ảnh tải xong, tối đa 4 giây
  function waitLoaded(img) {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
      setTimeout(resolve, 4000);
    });
  }

  // Đọc ảnh blob: ngay trong trang (cùng origin nên fetch được), trả về data URL.
  // Định dạng ngoài png/jpeg/webp (gif, avif...) được vẽ lại thành PNG.
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
      // blob đã bị thu hồi hoặc bị CSP chặn: vẽ lại từ thẻ <img> đang hiển thị
      const img = findImage(url);
      if (!img || !img.naturalWidth) throw err;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    }
  }

  // Ảnh thu nhỏ cho side panel (side panel không mở được blob: của trang)
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

  // Danh sách ảnh đủ lớn trên trang, không trùng URL
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

  // Ảnh lazy trong div cuộn chưa tải vì chưa cuộn tới: ép tải ngay
  function forceEagerImages() {
    for (const i of document.images) if (i.loading === 'lazy') i.loading = 'eager';
  }

  async function listPageImages() {
    forceEagerImages();
    await Promise.all([...document.images].map(waitLoaded));
    return { images: collectImageUrls() };
  }

  // selected: danh sách URL người dùng đã chọn trong side panel; không có thì lấy tất cả
  async function collectAndTranslateAll(selected) {
    showPanel('Đang tải các ảnh trên trang...', null);
    let urls;
    if (Array.isArray(selected)) {
      urls = selected;
    } else {
      forceEagerImages();
      await Promise.all([...document.images].map(waitLoaded));
      urls = collectImageUrls().map((x) => x.url);
    }
    showPanel(`Đang dịch ${urls.length} ảnh...`, null);
    chrome.runtime.sendMessage({ type: 'TRANSLATE_ALL', urls });
  }

  function removePanel() {
    panel?.remove();
    panel = null;
  }
})();
