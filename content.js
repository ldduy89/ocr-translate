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

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'START_SELECTION': startSelection(); break;
      case 'SHOW_LOADING':    showPanel('Đang nhận dạng và dịch...', null); break;
      case 'SHOW_RESULT':     showPanel(msg.translated, msg.original); break;
      case 'SHOW_ERROR':      showPanel('⚠ ' + msg.error, null); break;
      case 'HIDE_PANEL':      removePanel(); break;
      case 'OVERLAY_IMAGE':   overlayImage(msg); break;
      case 'TRANSLATE_ALL_START': collectAndTranslateAll(); break;
      case 'SHOW_INFO':       showPanel(msg.text, null); break;
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

  function layoutOverlay(entry) {
    const { img, layer, width, height, items } = entry;
    if (!img.isConnected) {
      layoutObserver.unobserve(img);
      layer.remove();
      overlayEntries.delete(entry.srcUrl);
      return;
    }
    const rect = img.getBoundingClientRect();
    const sx = rect.width / width;
    const sy = rect.height / height;
    Object.assign(layer.style, {
      left: rect.left + window.scrollX + 'px',
      top: rect.top + window.scrollY + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });

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

  function overlayImage({ srcUrl, width, height, items }) {
    const img = findImage(srcUrl);
    if (!img) {
      console.warn('[OCR] không tìm thấy <img> cho', srcUrl);
      return;
    }
    // Chỉ thay bản dịch của đúng ảnh này, giữ bản dịch các ảnh khác
    const old = overlayEntries.get(srcUrl);
    if (old) {
      layoutObserver.unobserve(old.img);
      old.layer.remove();
    }
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
    document.body.appendChild(layer);

    const entry = { srcUrl, img, layer, width, height, items };
    overlayEntries.set(srcUrl, entry);
    layoutObserver.observe(img);
    layoutOverlay(entry);
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

  async function collectAndTranslateAll() {
    showPanel('Đang tải các ảnh trên trang...', null);
    await Promise.all([...document.images].map(waitLoaded));

    const seen = new Set();
    const urls = [];
    for (const img of document.images) {
      const src = img.currentSrc || img.src;
      if (!src || !/^(https?:|data:image\/)/.test(src)) continue;
      if (seen.has(src)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) continue;
      if (img.naturalWidth < 120) continue;
      seen.add(src);
      urls.push(src);
    }
    showPanel(`Đang dịch ${urls.length} ảnh trên trang...`, null);
    chrome.runtime.sendMessage({ type: 'TRANSLATE_ALL', urls });
  }

  function removePanel() {
    panel?.remove();
    panel = null;
  }
})();
