/**
 * 活動與任務追蹤（event-ops）的 API：標案管理、供應商管理等 GitHub Pages 頁面共用。
 * 資料都存在 event-ops 的資料庫，身分由帳號中心的憑證證明（見 event-ops/src/Controller.js 的 doPost）。
 * 需先載入 sso.js。
 */
(function () {
  const API = 'https://script.google.com/macros/s/AKfycbyAUBGqD8ekrTyhMDfV0w0TMvljijG8CDmU8OIrGImPDCACvgrjl9QXv2q_dyi4arGq/exec';

  async function call(action, data) {
    let res;
    try {
      // 不設 Content-Type（預設 text/plain），避免觸發 Apps Script 不支援的 CORS 預檢。
      res = await fetch(API, { method: 'POST', body: JSON.stringify(Object.assign({ action, token: ImprSSO.getToken() }, data || {})) });
    } catch (e) {
      throw apiError('NETWORK', '連線失敗，請檢查網路後再試');
    }
    let json;
    try { json = await res.json(); } catch (e) { throw apiError('INTERNAL', '系統暫時無法使用，請稍後再試'); }
    if (json.ok) return json.data;
    const authCode = json.error.details && json.error.details.authCode;
    // 憑證過期或帳號停用就回登入頁；沒有權限（FORBIDDEN）則留在頁面上顯示原因。
    if (authCode === 'TOKEN' || authCode === 'DISABLED') ImprSSO.logout();
    throw apiError(authCode || json.error.code, json.error.message);
  }

  function apiError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  window.EventApi = { call };
})();
