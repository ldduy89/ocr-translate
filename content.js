(() => {
  if (window.__ocrTranslateInjected) return;
  window.__ocrTranslateInjected = true;

  let panel = null;

  // Ghi nhớ ảnh vừa chuột phải để biết phủ bản dịch lên đúng thẻ <img>
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
        // "Đang dịch: x/x" giữ nguyên đến khi xong; thông báo khác tự ẩn sau TOAST_MS
        const progressing = /^Đang dịch/.test(msg.text);
        showToast(msg.text, progressing ? 'info' : 'success', progressing ? 0 : TOAST_MS);
        break;
      }
      case 'SCROLL_TO_IMAGE': scrollToImage(msg.url); break;
      case 'NOTEXT':          markNoText(msg.srcUrl); break;
      case 'MENU_TRANSLATE':  sendResponse({ handled: translateFromMenu(msg.srcUrl) }); break;
      case 'FETCH_BLOB':
        blobUrlToDataUrl(msg.url).then((dataUrl) => sendResponse({ dataUrl }), (err) => sendResponse({ error: String(err && err.message || err) }));
        return true;
    }
  });

  // ---------- Theo dõi thay đổi ảnh trên trang -> báo side panel làm mới danh sách ----------
  const OWN_SELECTOR = '#ocr-pill-host, .ocr-img-overlay, #ocr-panel, #ocr-toast';
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
    }, 700); // gom nhiều thay đổi liên tiếp (div bị vẽ lại) thành 1 lần
  }
  function startImageWatch() {
    if (!document.body) return;
    new MutationObserver((records) => {
      for (const m of records) {
        if (isOwnNode(m.target)) continue; // bỏ qua thay đổi do extension tự tạo
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
    // Ảnh lazy gán src xong mới tải xong: báo thêm khi load
    document.addEventListener('load', (e) => {
      if (e.target && e.target.tagName === 'IMG' && !isOwnNode(e.target)) notifyImagesChanged();
    }, true);
  }
  startImageWatch();

  // Thông báo trạng thái / lỗi: toast nhỏ góc dưới phải. ms = 0 thì giữ đến khi tự đóng hoặc có thông báo mới.
  // Khung "Dịch ảnh" không dùng cho thông báo nữa.
  const TOAST_MS = 20000; // thời gian tự ẩn của thông báo thường
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
    el.style.pointerEvents = 'auto'; // bấm được để đóng
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

  // Chỉ trả về <img> có đúng địa chỉ ảnh. Không đoán bằng ảnh chuột phải gần nhất,
  // vì như vậy bản dịch của ảnh khác sẽ bị phủ nhầm lên ảnh không được dịch
  function findImage(srcUrl) {
    if (lastContextImg && (lastContextImg.currentSrc === srcUrl || lastContextImg.src === srcUrl)) {
      return lastContextImg;
    }
    return [...document.images].find((i) => i.currentSrc === srcUrl || i.src === srcUrl) || null;
  }

  // Cuộn trang (và các div cuộn chứa ảnh) tới ảnh có địa chỉ srcUrl. Dùng khi bấm ảnh đã dịch / không có chữ ở side panel.
  // Ảnh cao hơn khung nhìn thì đưa đầu ảnh lên đầu khung; ảnh vừa khung thì canh giữa.
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
  const MIN_FONT = 9; // sàn cứng: dưới mức này chữ không đọc được nữa

  // maxSize: cỡ chữ tối đa theo chữ gốc trên hình (có thể không có)
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
    if (!fitted) size = MIN_FONT; // thật sự không vừa: dùng cỡ nhỏ nhất, chấp nhận tràn nhẹ
    measureCtx.font = `${size}px ${FONT_FAMILY}`;
    lines = wrapWords(text, w);
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
    if (entry.pin) { entry.pin.el.remove(); entry.pin = null; }
    overlayEntries.delete(entry.srcUrl);
    releaseHost(entry.host);
  }

  function aspectOf(im) {
    if (im.naturalWidth > 0) return im.naturalWidth / im.naturalHeight;
    const r = im.getBoundingClientRect();
    return r.width / Math.max(1, r.height);
  }

  // Danh sách <img> theo thứ tự DOM trong khung scroll (hoặc cả trang nếu ảnh không nằm trong div cuộn)
  function imagesIn(container) {
    return container === document ? [...document.images] : [...container.querySelectorAll('img')];
  }

  // Ghi nhớ ảnh đã dịch là ảnh thứ mấy trong khung scroll của nó
  function snapshotEntry(entry) {
    const im = entry.img;
    entry.cont = findScrollHost(im) || document;
    entry.ord = imagesIn(entry.cont).indexOf(im);
  }

  // Tìm lại ảnh thay thế: lấy đúng ảnh cùng số thứ tự trong khung scroll (vd đã dịch ảnh thứ 5 thì lấy ảnh thứ 5).
  // Ảnh đó chưa có hoặc khác tỉ lệ khung hình (lệch >5%) thì trả về null: ẩn tạm và thử lại, không đoán sang ảnh khác.
  function findByPosition(entry) {
    if (!(entry.ord >= 0)) return null;
    const cont = entry.cont && (entry.cont === document || entry.cont.isConnected) ? entry.cont : document;
    const cand = imagesIn(cont)[entry.ord];
    if (!cand || !cand.isConnected) return null;
    for (const e of overlayEntries.values()) if (e !== entry && e.img === cand) return null; // đã gắn bản dịch khác
    const aspectOld = entry.width / entry.height;
    return Math.abs(aspectOf(cand) / aspectOld - 1) <= 0.05 ? cand : null;
  }

  // Gắn bản dịch sang <img> mới / link mới và cập nhật khoá URL (kể cả trạng thái "Đã dịch" ở side panel).
  // Khác tỉ lệ ảnh nghĩa là ảnh khác hẳn: gỡ bản dịch cho khỏi sai chỗ.
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
    if (!newUrl) return false; // ảnh mới chưa có link (đang tải): thử lại lần sau
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
      // Trang dựng lại <img> (thường gặp khi cửa sổ đổi cỡ, vd mở side panel): tìm lại ảnh theo URL
      // và gắn bản dịch vào đó, không xoá bản dịch. Chưa thấy thì ẩn tạm và thử lại ở lần kiểm tra sau.
      // (URL cũ không còn thì tìm theo vị trí/kích thước, rồi cập nhật URL mới vào bản dịch)
      const again = findImage(entry.srcUrl) || findByPosition(entry);
      if (again && again.isConnected && rebindEntry(entry, again)) {
        img = entry.img;
      } else {
        if (overlayEntries.get(entry.srcUrl) === entry) { // chưa bị gỡ vì khác tỉ lệ: ẩn tạm, thử lại sau
          layer.style.display = 'none';
          if (entry.pin) setBtnShown(entry.pin.el, false);
        }
        return;
      }
    } else if (imgKey(img) && imgKey(img) !== entry.srcUrl) {
      // Cùng thẻ <img> nhưng trang đổi sang link khác: cập nhật link, giữ bản dịch
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
      display: entry.hidden || rect.width < 1 || rect.height < 1 ? 'none' : 'block',
      left: left + 'px',
      top: top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });
    updatePin(entry);

    // Chỉ dựng lại chữ khi kích thước ảnh đổi; chỉ cuộn hoặc dịch chỗ thì chỉ cần dời lớp
    const sizeKey = rect.width.toFixed(1) + 'x' + rect.height.toFixed(1);
    if (entry.sizeKey === sizeKey) return;
    entry.sizeKey = sizeKey;
    snapshotEntry(entry);

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
      // Vùng chữ: elip chỉ dùng phần chữ nhật nằm gọn trong elip (~73%); khung chữ nhật chừa lề đều 7%
      // (tối thiểu 6px) để chữ không sát hoặc bị cắt ở mép
      const k = ellipse ? 0.73 : 1; // 0,78 cũ làm chữ chạm mép; 0,73 là mức vừa phải
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
        overflow: 'visible', // chỉ tràn khi đã xuống cỡ chữ sàn
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
  // Cuộn ở bất kỳ div nào (scroll không nổi bọt nên bắt ở giai đoạn capture)
  window.addEventListener('scroll', scheduleLayout, true);

  // Ảnh phía trên tải xong làm ảnh bên dưới dịch chỗ mà ảnh đó không đổi kích thước: kiểm tra định kỳ
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
    const entry = { srcUrl, img, layer, width, height, items, host: undefined, sizeKey: '', hidden: false };
    overlayEntries.set(srcUrl, entry);
    layoutObserver.observe(img);
    entry.flashUntil = Date.now() + 2500; // nháy ngay khi nút hiện, trong vòng 2,5 giây sau khi dịch xong
    entry.flashed = false;
    layoutOverlay(entry);
    removePendingPin(srcUrl); // nút cố định của bản dịch (updatePin trong layoutOverlay) thay vào ngay
    if (pillImg === img) hidePill(); // nút rê chuột nhường chỗ cho nút cố định
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

  // ================= Nút "Dịch ảnh" chỉ hiện khi rê chuột vào ảnh =================
  // Một nút duy nhất (Shadow DOM, không bị CSS của trang ảnh hưởng). Rê chuột vào ảnh thì nút hiện ở
  // góc trên bên phải phần ảnh đang thấy; rời ảnh, cuộn hoặc đổi cỡ cửa sổ thì nút ẩn. Không chạy nền.
  const BTN_TEXT = {
    idle: 'Dịch ảnh',
    notext: 'Không có chữ',
    waiting: 'Chờ dịch',
    loading: 'Đang dịch...',
    shown: '✓ Bản dịch',
    hidden: 'Xem bản dịch',
  };
  const BTN_MIN = 120;           // chỉ áp dụng cho ảnh hiển thị ≥ 120px mỗi chiều
  const HIDE_DELAY = 150;        // ms chờ trước khi ẩn nút khi chuột rời ảnh
  const pendingUrls = new Set(); // ảnh đang dịch bằng nút
  let pillHost = null;
  let pill = null;               // { el, label }
  let pillRoot = null;           // shadow root chứa mọi nút
  let pillImg = null;            // ảnh mà nút đang gắn
  let pillsEnabled = true;
  let hideTimer = null;
  let moveQueued = false;
  let lastX = -1; // -1: chưa biết vị trí chuột
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

  // Ẩn/hiện nút có hiệu ứng mờ + thu nhỏ. Hiện: đặt display rồi mới thêm .on để chạy hiệu ứng vào.
  // Ẩn: bỏ .on rồi sau khi hiệu ứng xong mới đặt display:none.
  function setBtnShown(el, on) {
    if (!el) return;
    clearTimeout(el._hideT);
    if (on) {
      if (el._shown) return;
      el._shown = true;
      el.style.display = 'flex';
      void el.offsetWidth; // ép trình duyệt tính layout trước khi đổi opacity/transform
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

  // Tạo một nút (icon + chữ) trong shadow root; onClick chạy khi bấm
  function makeButton(onClick) {
    const el = document.createElement('button');
    el.className = 'pill';
    el.type = 'button';
    const ico = document.createElement('span');
    ico.className = 'ico';
    const im = document.createElement('img');
    try { im.src = chrome.runtime.getURL('icons/icon48.png'); } catch (_) {}
    im.onerror = () => { ico.innerHTML = ICON_SVG; }; // chưa có icon thì dùng hình dự phòng
    ico.appendChild(im);
    const label = document.createElement('span');
    el.append(ico, label);
    // Hết hiệu ứng, hoặc bị huỷ vì nút bị ẩn (display:none khi ảnh cuộn ra khỏi màn hình) thì gỡ class,
    // để lúc nút hiện lại không bị chạy lại từ đầu: hiệu ứng chỉ chạy đúng một lần lúc vừa dịch xong
    for (const ev of ['animationend', 'animationcancel']) {
      el.addEventListener(ev, (e) => { if (e.animationName === 'flash') el.classList.remove('flash'); });
    }
    // Không cho sự kiện lọt xuống trang (tránh lật trang/zoom ảnh khi bấm nút)
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

  // Ảnh đã dịch: nút luôn hiện cố định ở góc trên phải phần ảnh đang thấy (không phụ thuộc rê chuột),
  // kể cả khi đang xem ảnh gốc, để còn bấm quay lại bản dịch
  function ensurePin(entry) {
    if (entry.pin && entry.pin.el.isConnected) return entry.pin;
    ensurePill(); // đảm bảo host/shadow root đã có
    entry.pin = makeButton(() => onPillClick(entry.img));
    return entry.pin;
  }

  function updatePin(entry) {
    const v = visibleRect(entry.img);
    if (pendingUrls.has(entry.srcUrl)) { // đang dịch lại: nút xoay thay chỗ nút này
      if (entry.pin) setBtnShown(entry.pin.el, false);
      return;
    }
    if (!pillsEnabled || v.r - v.l < BTN_MIN || v.b - v.t < 40) { // ảnh cuộn ra khỏi màn hình / quá nhỏ
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
    // Vừa dịch xong và nút đang hiện: nháy đúng một lần. Lúc overlayImage chạy thì nút còn bị ẩn
    // (pendingUrls chưa xoá), nên việc nháy được hoãn tới lần updatePin đầu tiên nút thực sự hiện.
    if (entry.flashUntil && !entry.flashed) {
      if (Date.now() <= entry.flashUntil) { entry.flashed = true; flashPin(entry); }
      else entry.flashUntil = 0; // quá hạn (ảnh nằm ngoài màn hình lúc dịch xong): bỏ, không nháy khi cuộn tới
    }
  }

  // Vừa dịch xong: nút nháy/nhún vài lần cho dễ thấy, rồi đứng yên
  function flashPin(entry) {
    const el = entry.pin && entry.pin.el;
    if (!el || !el._shown) return;
    el.classList.remove('flash');
    void el.offsetWidth; // khởi động lại animation
    el.classList.add('flash');
  }

  function imgKey(img) { return img.currentSrc || img.src; }

  // Ảnh đang dịch bằng nút: giữ nút (icon xoay) hiện cố định ở góc trên phải phần ảnh đang thấy,
  // không phụ thuộc rê chuột, đến khi dịch xong (nút cố định của bản dịch sẽ thay vào) hoặc lỗi.
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
    if (!p.img.isConnected) { // trang dựng lại thẻ <img>: tìm lại theo URL
      const again = findImage(key);
      if (again) p.img = again;
    }
    const v = p.img.isConnected ? visibleRect(p.img) : null;
    if (!pillsEnabled || !v || v.r - v.l < BTN_MIN || v.b - v.t < 40) { // đang ngoài màn hình: ẩn tạm, cuộn lại sẽ hiện
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

  // Cập nhật chữ/trạng thái của nút theo ảnh đang gắn (không đổi vị trí)
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
    if (entry) { // đã dịch: bấm để chuyển qua lại giữa ảnh gốc và bản dịch
      entry.hidden = !entry.hidden;
      entry.layer.style.display = entry.hidden ? 'none' : 'block';
      updatePin(entry);
      refreshPill();
      return;
    }
    startTranslate(img, key);
  }

  // Menu chuột phải "dịch ảnh này": chạy y như bấm nút trên ảnh (icon xoay trên ảnh, không mở bảng ở góc dưới phải).
  // Ảnh đã có bản dịch thì không dịch lại. Trả về false nếu không tìm thấy thẻ <img>
  // (vd ảnh nền CSS, ảnh trong iframe) để background dùng cách cũ.
  function translateFromMenu(srcUrl) {
    const img = findImage(srcUrl);
    if (!img) return false;
    const key = imgKey(img);
    if (!key) return false;
    const entry = overlayEntries.get(key);
    if (entry) { // đã dịch rồi: không dịch lại; đang xem ảnh gốc thì bật lại bản dịch
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
    hidePill(); // nút rê chuột nhường chỗ cho nút cố định đang xoay
    const done = () => {
      pendingUrls.delete(key); removePendingPin(key); refreshPill();
      const e = overlayEntries.get(key);
      if (e) updatePin(e); // hiện nút bản dịch (và nháy) ngay, khỏi chờ lần kiểm tra định kỳ
    };
    try {
      chrome.runtime.sendMessage({ type: 'TRANSLATE_ONE', srcUrl: key }, () => {
        void chrome.runtime.lastError;
        done();
      });
    } catch (_) {
      done(); // extension vừa được tải lại: cần F5 trang
    }
  }

  // Phần ảnh đang nhìn thấy: giao của ảnh, khung nhìn và các div cuộn/cắt chứa nó
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

  // Ảnh đã biết là không có chữ (background báo về): không hiện nút dịch
  const noTextKeys = new Set();
  const queuedKeys = new Set(); // ảnh đã được đưa vào lượt dịch nhiều ảnh nhưng chưa vẽ xong

  function markNoText(key) {
    if (!key) return;
    noTextKeys.add(key);
    if (pillImg && imgKey(pillImg) === key) refreshPill();
  }

  // Lúc tải trang: hỏi background danh sách ảnh đã biết là không có chữ của tab này
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
    // Vị trí tính lại mỗi lần đặt, để nút bám theo ảnh khi cuộn
    const place = () => {
      const v = visibleRect(img);
      if (v.r - v.l < BTN_MIN || v.b - v.t < 40) return false;
      p.el.style.left = Math.max(v.l, v.r - p.el.offsetWidth - 10) + 'px';
      p.el.style.top = v.t + 10 + 'px';
      return true;
    };
    const v = visibleRect(img);
    if (v.r - v.l < BTN_MIN || v.b - v.t < 40) { hidePill(); return; }
    // Đang hiện đúng ảnh này: chỉ bám vị trí
    if (p._target === img && p.el._shown) { place(); return; }
    // Đang chờ chuyển sang ảnh này: để hẹn giờ tự xử lý
    if (p._target === img && p._switchT) return;
    const wasShown = p.el._shown;
    p._target = img;
    clearTimeout(p._switchT);
    p._switchT = null;
    if (wasShown) {
      // Chuyển sang ảnh khác: thu nhỏ/mờ nút ở ảnh cũ, rồi hiện lại (có hiệu ứng) ở ảnh mới
      setBtnShown(p.el, false);
      p._switchT = setTimeout(() => {
        p._switchT = null;
        if (pillImg !== img) return;
        // Phải hiện nút trước rồi mới đặt vị trí: khi đang ẩn, offsetWidth = 0 nên nút bị đẩy sang phải ra ngoài ảnh
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

  // Tìm <img> đủ lớn nằm dưới con trỏ (kể cả khi bị lớp trong suốt của trang phủ lên)
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
    if (img && (overlayEntries.has(imgKey(img)) || pendingUrls.has(imgKey(img)))) img = null; // ảnh đã dịch / đang dịch đã có nút cố định
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
  // Nút không bám theo khi cuộn: ẩn đi, rê chuột lại sẽ hiện ở đúng chỗ mới
  // Đang cuộn: nút ở yên trên ảnh dưới con trỏ, chỉ dời theo góc trên-phải phần ảnh đang thấy
  // (ảnh khác trượt vào chỗ con trỏ thì nút chuyển sang ảnh đó)
  let scrollQueued = false;
  function onLayoutChange() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; onMove(true); });
  }
  window.addEventListener('scroll', onLayoutChange, true);
  window.addEventListener('resize', onLayoutChange);

  // Cho phép tắt nút: chrome.storage.sync { showImageButton: false }
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

  function removePanel() {
    panel?.remove();
    panel = null;
  }
})();
