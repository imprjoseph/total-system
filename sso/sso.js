/**
 * imPR 共用登入：所有放在 imprjoseph.github.io 的內部系統都載入這支檔案。
 *   <script src="https://imprjoseph.github.io/total-system/sso/sso.js"></script>
 *
 * 憑證存在 localStorage，因為同一個網域下的所有 GitHub Pages 系統共用 localStorage，
 * 在入口網站登入一次，其他系統就讀得到，這就是「一套帳號進入全部系統」的做法。
 * 憑證只是登入證明；各系統後端仍要用帳號中心驗證，不能只信瀏覽器端解出來的角色。
 */
(function () {
  const API = 'https://script.google.com/macros/s/AKfycbzBEXIU7diy0fdpz4p-N-pKCDem4xL5BnNSptSzRLYi8Hd3ccvLcLAPTY-K2WrLDclYZQ/exec';
  const TOKEN_KEY = 'impr_sso_token';
  // 登入頁位置以這支檔案為基準推算，本機預覽和正式網址都能用。
  const scriptUrl = (document.currentScript && document.currentScript.src) || location.href;
  const LOGIN_URL = new URL('../login/', scriptUrl).href;
  const PORTAL_URL = new URL('../portal/', scriptUrl).href;

  function storage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function getToken() {
    const s = storage();
    try { return s ? s.getItem(TOKEN_KEY) : null; } catch (e) { return null; }
  }

  function setToken(token) {
    const s = storage();
    try { if (s) s.setItem(TOKEN_KEY, token); } catch (e) { /* 無痕模式寫不進去時，本頁仍可使用 */ }
  }

  function clearToken() {
    const s = storage();
    try { if (s) s.removeItem(TOKEN_KEY); } catch (e) { /* 同上 */ }
  }

  function decode(token) {
    try {
      const p = String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(p + '==='.slice(0, (4 - p.length % 4) % 4));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
    } catch (e) {
      return null;
    }
  }

  /** 目前登入者（只看憑證是否逾時，不連線）；未登入回傳 null。 */
  function getUser() {
    const token = getToken();
    const payload = token && decode(token);
    if (!payload || !payload.exp || payload.exp * 1000 <= Date.now()) return null;
    return { account: payload.sub, name: payload.name, type: payload.type || '正職', admin: payload.admin === true, roles: payload.roles || {} };
  }

  async function call(action, data) {
    let res;
    try {
      // 不設 Content-Type（預設 text/plain），避免觸發 Apps Script 不支援的 CORS 預檢。
      res = await fetch(API, { method: 'POST', body: JSON.stringify(Object.assign({ action }, data || {})) });
    } catch (e) {
      throw codeError('NETWORK', '無法連線到帳號中心，請檢查網路後再試');
    }
    let json;
    try { json = await res.json(); } catch (e) { throw codeError('INTERNAL', '帳號中心暫時無法使用，請稍後再試'); }
    if (!json.ok) throw codeError(json.error.code, json.error.message);
    return json.data;
  }

  function codeError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  async function login(account, password) {
    const data = await call('login', { account, password });
    setToken(data.token);
    return data.user;
  }

  /** 回查帳號中心：拿到最新角色與新憑證。帳號停用或憑證失效時清掉登入狀態並丟出錯誤。 */
  async function refresh() {
    const token = getToken();
    if (!token) throw codeError('TOKEN', '尚未登入');
    try {
      const data = await call('me', { token });
      setToken(data.token);
      return data.user;
    } catch (e) {
      if (e.code === 'TOKEN' || e.code === 'DISABLED') clearToken();
      throw e;
    }
  }

  async function changePassword(oldPassword, newPassword) {
    const data = await call('changePassword', { token: getToken(), oldPassword, newPassword });
    setToken(data.token);
    return data.user;
  }

  /** 帶目前憑證呼叫帳號中心（例如帳號管理）。憑證失效或帳號停用時清掉登入狀態。 */
  async function request(action, data) {
    try {
      return await call(action, Object.assign({}, data || {}, { token: getToken() }));
    } catch (e) {
      if (e.code === 'TOKEN' || e.code === 'DISABLED') clearToken();
      throw e;
    }
  }

  function logout() {
    clearToken();
    location.href = LOGIN_URL;
  }

  /** 未登入就導向登入頁，登入後回到目前頁面；已登入則回傳登入者。 */
  function requireLogin() {
    const user = getUser();
    if (user) return user;
    clearToken();
    location.replace(LOGIN_URL + '?next=' + encodeURIComponent(location.href));
    return null;
  }

  /** 登入後要回去的網址只接受同網域，避免登入頁被拿來把人導到釣魚網站。 */
  function safeNext(next) {
    try {
      const url = new URL(next, location.href);
      if (url.origin === location.origin) return url.href;
    } catch (e) { /* 落到預設值 */ }
    return PORTAL_URL;
  }

  window.ImprSSO = { getToken, getUser, login, refresh, changePassword, request, logout, requireLogin, safeNext, LOGIN_URL, PORTAL_URL };
})();
