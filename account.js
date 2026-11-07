// Tài khoản: đăng nhập Google, lấy thông tin/lượt dịch/Gemini key từ server.
// Nạp bằng importScripts trong background.js và bằng <script> trong popup.html.

// Đổi thành địa chỉ server thật khi triển khai (https://...). Khi thử trên máy thì để localhost.
const SERVER_URL = 'http://localhost:3000';

const Account = (() => {
  const KEY = 'account'; // chrome.storage.local: { token, user: { email, name, credits, gemini_key } }

  async function load() {
    return (await chrome.storage.local.get({ [KEY]: null }))[KEY];
  }

  async function save(value) {
    if (value) await chrome.storage.local.set({ [KEY]: value });
    else await chrome.storage.local.remove(KEY);
  }

  // Gọi server; trả về { status, data }. Lỗi mạng thì ném lỗi dễ hiểu.
  async function api(path, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(SERVER_URL + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('Không kết nối được tới server. Kiểm tra mạng rồi thử lại.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.error === 'region_blocked') {
      throw new Error('Dịch vụ tạm thời chưa hỗ trợ khu vực của bạn (EEA, Thụy Sĩ, Anh).');
    }
    return { status: res.status, data };
  }

  // Token Google do Chrome cấp (tài khoản đang đăng nhập trong trình duyệt)
  async function googleToken(interactive) {
    const r = await chrome.identity.getAuthToken({ interactive });
    return typeof r === 'string' ? r : r && r.token;
  }

  async function patchCredits(n) {
    const acc = await load();
    if (acc && Number.isFinite(n)) {
      acc.user.credits = n;
      await save(acc);
    }
  }

  // Đăng nhập: đổi token Google lấy phiên của server
  async function login(interactive = true) {
    let gt;
    try {
      gt = await googleToken(interactive);
    } catch (e) {
      throw new Error('Không đăng nhập được Google: ' + (e && e.message ? e.message : e));
    }
    if (!gt) throw new Error('Không lấy được token Google.');
    const { status, data } = await api('/auth/google', { method: 'POST', body: { access_token: gt } });
    if (status !== 200) {
      await chrome.identity.removeCachedAuthToken({ token: gt }).catch(() => {}); // token hỏng thì bỏ để lần sau lấy mới
      throw new Error(status === 401
        ? 'Server từ chối token Google (kiểm tra GOOGLE_CLIENT_ID ở server và client_id trong manifest).'
        : `Lỗi server (${status}).`);
    }
    const acc = { token: data.token, user: data.user };
    await save(acc);
    return acc;
  }

  // Cập nhật thông tin tài khoản (lượt còn lại, Gemini key). Phiên hết hạn thì đăng nhập lại im lặng.
  async function refresh() {
    const acc = await load();
    if (!acc) return null;
    const r = await api('/me', { token: acc.token });
    if (r.status === 401) {
      try {
        return await login(false);
      } catch {
        await save(null);
        return null;
      }
    }
    if (r.status !== 200) throw new Error(`Lỗi server (${r.status}).`);
    const next = { token: acc.token, user: r.data };
    await save(next);
    return next;
  }

  // Dùng trước khi dịch: phải đăng nhập và có Gemini key
  async function require() {
    const acc = await refresh();
    if (!acc) throw new Error('Hãy đăng nhập Google trong side panel để dịch.');
    if (!acc.user.gemini_key) {
      throw new Error('Tài khoản đang được chuẩn bị key Gemini. Thử lại sau vài giây; nếu vẫn lỗi, liên hệ người quản trị.');
    }
    return acc;
  }

  // Trừ lượt trước khi gọi Gemini. Trả về ref để hoàn lượt nếu dịch không thành.
  async function charge(count) {
    const acc = await require();
    const ref = crypto.randomUUID();
    const { status, data } = await api('/usage', { method: 'POST', token: acc.token, body: { count, ref } });
    if (status === 402) {
      await patchCredits(data.credits);
      throw new Error(`Không đủ lượt dịch: cần ${count}, còn ${data.credits}.`);
    }
    if (status !== 200) throw new Error(`Không trừ được lượt dịch (${status}).`);
    await patchCredits(data.credits);
    return ref;
  }

  // Hoàn lượt (không ném lỗi: hoàn không được thì thôi, không làm hỏng luồng dịch)
  async function refund(ref, count) {
    if (!ref || !(count >= 1)) return;
    try {
      const acc = await load();
      if (!acc) return;
      const { status, data } = await api('/usage/refund', { method: 'POST', token: acc.token, body: { ref, count } });
      if (status === 200) await patchCredits(data.credits);
    } catch { /* bỏ qua */ }
  }

  async function logout() {
    try {
      const t = await googleToken(false);
      if (t) await chrome.identity.removeCachedAuthToken({ token: t });
    } catch { /* bỏ qua */ }
    await save(null);
  }

  async function geminiKey() {
    const acc = await load();
    return (acc && acc.user && acc.user.gemini_key) || '';
  }

  return { load, login, refresh, require, charge, refund, logout, geminiKey };
})();
