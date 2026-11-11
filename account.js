// Account: Google sign-in; fetches account info, credits and the Gemini key from the server.
// Loaded with importScripts in background.js and with a <script> tag in popup.html.

// Change to the real server address when deploying (https://...). Keep localhost when testing locally.
// const SERVER_URL = 'http://localhost:3000';
const SERVER_URL = 'https://ddtechtrans.up.railway.app';

const Account = (() => {
  const KEY = 'account'; // chrome.storage.local: { token, user: { email, name, credits, credits_free, credits_paid, gemini_key } }

  async function load() {
    return (await chrome.storage.local.get({ [KEY]: null }))[KEY];
  }

  async function save(value) {
    if (value) await chrome.storage.local.set({ [KEY]: value });
    else await chrome.storage.local.remove(KEY);
  }

  // Call the server; returns { status, data }. Network errors throw a clear message.
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

  // Google token issued by Chrome (the account signed in to the browser)
  async function googleToken(interactive) {
    const r = await chrome.identity.getAuthToken({ interactive });
    return typeof r === 'string' ? r : r && r.token;
  }

  // Update credit counts from the server response: { credits, credits_free, credits_paid }
  async function patchCredits(data) {
    const acc = await load();
    if (acc && data && Number.isFinite(data.credits)) {
      acc.user.credits = data.credits;
      if (Number.isFinite(data.credits_free)) acc.user.credits_free = data.credits_free;
      if (Number.isFinite(data.credits_paid)) acc.user.credits_paid = data.credits_paid;
      await save(acc);
    }
  }

  // Sign in: exchange the Google token for a server session
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
      await chrome.identity.removeCachedAuthToken({ token: gt }).catch(() => {}); // drop a broken token so a new one is fetched next time
      throw new Error(status === 401
        ? 'Server từ chối token Google (kiểm tra GOOGLE_CLIENT_ID ở server và client_id trong manifest).'
        : `Lỗi server (${status}).`);
    }
    const acc = { token: data.token, user: data.user };
    await save(acc);
    return acc;
  }

  // Refresh account info (remaining credits, Gemini key). If the session expired, sign in again silently.
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

  // Required before translating: must be signed in and have a Gemini key
  async function require() {
    const acc = await refresh();
    if (!acc) throw new Error('Hãy đăng nhập Google trong side panel để dịch.');
    // Out of credits means the key was revoked: report the real cause instead of "preparing key"
    if (!(acc.user.credits > 0)) {
      throw new Error('Bạn đã hết lượt dịch. Vui lòng mua thêm lượt để tiếp tục.');
    }
    if (!acc.user.gemini_key) {
      throw new Error('Tài khoản đang được chuẩn bị key Gemini. Thử lại sau vài giây; nếu vẫn lỗi, liên hệ người quản trị.');
    }
    return acc;
  }

  // Deduct credits before calling Gemini. Returns a ref to refund if translation fails.
  async function charge(count) {
    const acc = await require();
    const ref = crypto.randomUUID();
    const { status, data } = await api('/usage', { method: 'POST', token: acc.token, body: { count, ref } });
    if (status === 402) {
      await patchCredits(data);
      throw new Error(`Không đủ lượt dịch: cần ${count}, còn ${data.credits}.`);
    }
    if (status !== 200) throw new Error(`Không trừ được lượt dịch (${status}).`);
    await patchCredits(data);
    return ref;
  }

  // Refund credits (does not throw: if the refund fails, give up quietly without breaking the translation flow)
  async function refund(ref, count) {
    if (!ref || !(count >= 1)) return;
    try {
      const acc = await load();
      if (!acc) return;
      const { status, data } = await api('/usage/refund', { method: 'POST', token: acc.token, body: { ref, count } });
      if (status === 200) await patchCredits(data);
    } catch { /* ignore */ }
  }

  async function logout() {
    try {
      const t = await googleToken(false);
      if (t) await chrome.identity.removeCachedAuthToken({ token: t });
    } catch { /* ignore */ }
    await save(null);
  }

  async function geminiKey() {
    const acc = await load();
    return (acc && acc.user && acc.user.gemini_key) || '';
  }

  return { load, login, refresh, require, charge, refund, logout, geminiKey };
})();
