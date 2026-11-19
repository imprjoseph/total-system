/**
 * imPR 帳號中心：公司內部系統共用的帳號服務。
 *
 * 依管理者決定，密碼以明碼存放在 accounts 分頁；所以這份試算表只能分享給管理者本人，
 * 其他系統一律呼叫本服務或驗證本服務發的憑證，不直接讀這張表，否則任何拿到資料庫權限的人都看得到全公司密碼。
 *
 * 部署設定：以「我」執行、所有人（含匿名）可存取。GitHub Pages 上的系統沒有 Google 登入，
 * 只能匿名呼叫；身分由帳號密碼與簽章憑證負責，而不是 Google 存取權。
 */

const SHEET_NAME = 'accounts';
// 一個工作天。各系統只檢查簽章不回頭查表，帳號停用最晚在這段時間後全面失效。
const TOKEN_TTL_SEC = 12 * 3600;
// 服務對所有人開放，沒有失敗次數限制就能無限猜密碼。
const MAX_FAILS = 5;
const LOCK_SEC = 15 * 60;
const MIN_PASSWORD_LENGTH = 6;

// admin 勾選的人才能用帳號管理頁；帳號中心本身的權限也放在這張表，管理者不必另外維護一份名單。
// manager：直屬主管的帳號。出勤審核、派遣、週報都要知道「誰的主管是誰」，放在這裡就只維護一次。
const BASE_COLUMNS = ['account', 'password', 'name', 'email', 'dept', 'manager', 'type', 'active', 'admin', 'note'];

/**
 * 帳號類型。派遣人員只能使用派遣系統：他們不是公司同仁，不該看到客戶、利潤、內部專案等資料。
 * 限制做在帳號中心（角色過濾、verify 拒絕），不只靠入口網站隱藏，否則知道網址就能直接進其他系統。
 */
const ACCOUNT_TYPES = { STAFF: '正職', DISPATCH: '派遣' };
// office：新的公司系統，派遣人員在裡面只看得到自己的派遣功能（見 impr-office Auth.js）。
const DISPATCH_SYSTEMS = ['PT-member', 'office'];
/**
 * 每個系統一欄角色，欄名就是入口網站上的系統 id；空白代表不能使用該系統。
 * 角色值限定在 roles 清單內：沿用各系統原本的角色名稱，之後各系統改用帳號中心時可以直接對應，
 * 也避免手打 mangaer 這類錯字，讓某人莫名其妙沒有權限。
 */
const SYSTEMS = [
  { id: 'activity-tracker', name: '活動與任務追蹤', roles: ['admin', 'pm', 'staff'] },
  { id: 'impr-attendance', name: '公司同仁出勤', roles: ['admin', 'manager', 'staff'] },
  { id: 'PT-member', name: '派遣人員勤務', roles: ['admin', 'manager', 'staff'] },
  { id: 'project-pulse-impr', name: '工時與週報', roles: ['admin', 'manager', 'staff'] },
  { id: 'custormers-and-suppliers', name: '客戶與供應商管理', roles: ['SUPER_ADMIN', 'SALES', 'PM'] },
  { id: 'resource', name: '公司資源管理（資材、派遣、SOP）', roles: ['admin', 'manager', 'staff'] },
  { id: 'speaker-platform', name: '講師接待', roles: ['admin', 'staff'] },
  { id: 'ai-design', name: 'AI 平面設計', roles: ['admin', 'designer', 'staff'] },
  // admin / manager 可改所有標案；staff 只能改自己負責的（見 event-ops TenderService）
  { id: 'tender', name: '標案管理', roles: ['admin', 'manager', 'staff'] },
  // 新的公司系統（impr-office）：accountant 付款與看全部預算，dispatch 是派遣人員。
  { id: 'office', name: 'imPR 公司系統', roles: ['admin', 'manager', 'accountant', 'staff', 'dispatch'] },
];
const SYSTEM_COLUMNS = SYSTEMS.map(s => s.id);

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function doGet() {
  return json_({ ok: true, data: { service: 'impr-auth' } });
}

/**
 * 前端用 text/plain 送 JSON，是為了避開 CORS 預檢；Apps Script 不處理 OPTIONS 請求。
 */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_(fail_('VALIDATION', '請求格式錯誤'));
  }
  try {
    return json_({ ok: true, data: route_(body.action, body) });
  } catch (err) {
    if (err instanceof AuthError) return json_(fail_(err.code, err.message));
    console.error(err && err.stack || err);
    return json_(fail_('INTERNAL', '系統錯誤，請稍後再試'));
  }
}

function route_(action, b) {
  switch (action) {
    case 'login': return login_(b.account, b.password);
    case 'me': return me_(b.token);
    case 'verify': return verify_(b.token, b.system);
    case 'changePassword': return changePassword_(b.token, b.oldPassword, b.newPassword);
    case 'admin.list': return adminList_(b.token);
    case 'admin.save': return adminSave_(b.token, b.account, b.isNew, b.password);
    case 'admin.resetPassword': return adminResetPassword_(b.token, b.account, b.password);
    case 'directory': return directory_(b.token, b.system);
  }
  throw new AuthError('VALIDATION', '不支援的動作');
}

function login_(account, password) {
  const key = normAccount_(account);
  if (!key || !password) throw new AuthError('VALIDATION', '請輸入帳號與密碼');
  assertNotLocked_(key);
  const row = findAccount_(key);
  // 帳號不存在也計次、回同一句話，避免被拿來試出哪些帳號存在。
  if (!row || row.password !== String(password)) {
    recordFail_(key);
    throw new AuthError('AUTH', '帳號或密碼錯誤');
  }
  if (!row.active) throw new AuthError('DISABLED', '此帳號已停用，請聯絡管理者');
  clearFails_(key);
  return { token: issueToken_(row), user: publicUser_(row) };
}

/**
 * 入口網站每次開啟時呼叫：回查帳號表，讓停用與角色變更立即反映，並換發新憑證。
 */
function me_(token) {
  const row = activeAccountFor_(token);
  return { token: issueToken_(row), user: publicUser_(row) };
}

/**
 * 給各系統後端用：確認憑證有效、帳號仍啟用，並回傳該系統的角色。
 */
function verify_(token, system) {
  const row = activeAccountFor_(token);
  const user = publicUser_(row);
  if (system) {
    if (SYSTEM_COLUMNS.indexOf(system) === -1) throw new AuthError('VALIDATION', '未知的系統：' + system);
    if (!user.roles[system]) throw new AuthError('FORBIDDEN', '你沒有這個系統的使用權限，請聯絡管理者');
  }
  return { user, role: system ? user.roles[system] : null };
}

/**
 * 某系統的人員名單，給各系統同步人員資料、做人名選單，免得在各系統重複輸入。
 * 該系統的 admin / manager 拿到完整資料（email、直屬主管）以便同步；
 * 一般同仁只拿到帳號、姓名、部門、角色，夠選「借用人」「負責人」即可，不必看到全公司的 email 與主管關係。
 */
function directory_(token, system) {
  const me = publicUser_(activeAccountFor_(token));
  if (SYSTEM_COLUMNS.indexOf(system) === -1) throw new AuthError('VALIDATION', '未知的系統：' + system);
  const myRole = me.roles[system];
  if (!myRole) throw new AuthError('FORBIDDEN', '你沒有這個系統的使用權限，請聯絡管理者');
  const full = myRole === 'admin' || myRole === 'manager';
  const users = readAccounts_().rows.filter(r => r.active).map(publicUser_)
    .filter(u => u.roles[system])
    .map(u => full
      ? { account: u.account, name: u.name, email: u.email, dept: u.dept, manager: u.manager, type: u.type, role: u.roles[system] }
      : { account: u.account, name: u.name, dept: u.dept, role: u.roles[system] });
  return { system, users };
}

function changePassword_(token, oldPassword, newPassword) {
  const next = String(newPassword || '');
  if (next.length < MIN_PASSWORD_LENGTH) throw new AuthError('VALIDATION', '新密碼至少 ' + MIN_PASSWORD_LENGTH + ' 個字元');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new AuthError('LOCK', '系統忙碌中，請稍後再試');
  try {
    const row = activeAccountFor_(token);
    // 和登入共用失敗次數：拿到別人已登入的瀏覽器，也不能在這裡無限猜出原密碼。
    const key = normAccount_(row.account);
    assertNotLocked_(key);
    if (row.password !== String(oldPassword || '')) {
      recordFail_(key);
      throw new AuthError('AUTH', '目前密碼不正確');
    }
    clearFails_(key);
    if (next === row.password) throw new AuthError('VALIDATION', '新密碼不能和目前密碼相同');
    sheet_().getRange(row.rowNumber, row.columns.password).setValue(next);
    row.password = next;
    return { token: issueToken_(row), user: publicUser_(row) };
  } finally {
    lock.releaseLock();
  }
}

function assertNotLocked_(key) {
  if (Number(CacheService.getScriptCache().get('fail:' + key) || 0) >= MAX_FAILS) {
    throw new AuthError('LOCKED', '密碼錯誤次數過多，請 15 分鐘後再試');
  }
}

function recordFail_(key) {
  const cache = CacheService.getScriptCache();
  cache.put('fail:' + key, String(Number(cache.get('fail:' + key) || 0) + 1), LOCK_SEC);
}

function clearFails_(key) {
  CacheService.getScriptCache().remove('fail:' + key);
}

function activeAccountFor_(token) {
  const payload = readToken_(token);
  const row = findAccount_(payload.sub);
  if (!row || !row.active) throw new AuthError('DISABLED', '此帳號已停用，請聯絡管理者');
  return row;
}

// ---------- 帳號表 ----------

function sheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('找不到 accounts 分頁，請先執行 setupAccounts');
  return sheet;
}

function findAccount_(key) {
  return readAccounts_().rows.filter(row => normAccount_(row.account) === key)[0] || null;
}

/**
 * 整張表一次讀進來。欄位依表頭名稱對應，管理者在試算表調整欄位順序也不影響。
 */
function readAccounts_() {
  const values = sheet_().getDataRange().getValues();
  const header = values[0].map(h => String(h).trim());
  const columns = {};
  header.forEach((h, i) => { columns[h] = i + 1; });
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const raw = values[r];
    if (!String(raw[columns.account - 1] == null ? '' : raw[columns.account - 1]).trim()) continue;
    const row = { rowNumber: r + 1, columns };
    header.forEach((h, i) => { row[h] = raw[i]; });
    row.account = String(row.account).trim();
    row.password = String(row.password);
    row.active = isTruthy_(row.active);
    row.admin = isTruthy_(row.admin);
    rows.push(row);
  }
  return { header, columns, rows };
}

function publicUser_(row) {
  const type = accountType_(row.type);
  const roles = {};
  SYSTEM_COLUMNS.forEach(s => {
    if (type === ACCOUNT_TYPES.DISPATCH && DISPATCH_SYSTEMS.indexOf(s) === -1) return;
    const role = String(row[s] == null ? '' : row[s]).trim();
    if (role) roles[s] = role;
  });
  return {
    // 一律小寫：各系統用帳號對應主管、負責人，大小寫不同就會對不上
    account: normAccount_(row.account),
    name: String(row.name || row.account),
    email: String(row.email || ''),
    dept: String(row.dept || ''),
    manager: normAccount_(row.manager),
    type,
    // 派遣帳號就算在試算表被勾了 admin 也不生效。
    admin: !!row.admin && type !== ACCOUNT_TYPES.DISPATCH,
    roles,
  };
}

// 空白或不認得的值一律當正職：既有帳號在加這個欄位前都是同仁。
function accountType_(v) {
  return String(v == null ? '' : v).trim() === ACCOUNT_TYPES.DISPATCH ? ACCOUNT_TYPES.DISPATCH : ACCOUNT_TYPES.STAFF;
}

// 帳號不分大小寫、去頭尾空白，避免同事輸入 Amy 和 amy 被當成兩個人。
function normAccount_(account) {
  return String(account == null ? '' : account).trim().toLowerCase();
}

// active 欄可能是核取方塊或手打的文字，常見寫法都要接受。
function isTruthy_(v) {
  if (v === true) return true;
  return ['true', '是', 'y', 'yes', '1', 'v'].indexOf(String(v).trim().toLowerCase()) !== -1;
}

// ---------- 憑證 ----------

function issueToken_(row) {
  const now = Math.floor(Date.now() / 1000);
  const user = publicUser_(row);
  const payload = { sub: normAccount_(row.account), name: user.name, type: user.type, admin: user.admin, roles: user.roles, iat: now, exp: now + TOKEN_TTL_SEC };
  const body = b64_(JSON.stringify(payload));
  return body + '.' + sign_(body);
}

function readToken_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !safeEqual_(sign_(parts[0]), parts[1])) {
    throw new AuthError('TOKEN', '登入已失效，請重新登入');
  }
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad_(parts[0]))).getDataAsString('UTF-8'));
  } catch (e) {
    throw new AuthError('TOKEN', '登入已失效，請重新登入');
  }
  if (!payload.exp || payload.exp < Date.now() / 1000) throw new AuthError('TOKEN', '登入已逾時，請重新登入');
  return payload;
}

function sign_(body) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret_())).replace(/=+$/, '');
}

function b64_(text) {
  return Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function pad_(s) {
  return s + '==='.slice(0, (4 - s.length % 4) % 4);
}

// 逐字元比對完才回傳，讓比對時間不洩漏簽章對了幾個字。
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function secret_() {
  const s = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!s) throw new Error('尚未設定 TOKEN_SECRET，請先執行 setupAccounts');
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  return { ok: false, error: { code, message } };
}
