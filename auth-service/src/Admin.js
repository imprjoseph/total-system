/**
 * 帳號管理：只有 admin 勾選的帳號能用。給帳號管理頁（total-system/admin/）呼叫。
 *
 * 清單不回傳密碼：管理頁在瀏覽器裡，任何能偷到管理者憑證的人都會一次拿到全公司密碼；
 * 要看原密碼請直接開試算表（只有管理者本人有權限）。網頁上只能重設。
 */

const ACCOUNT_PATTERN_ = /^[a-z0-9._-]{2,32}$/;
const EDITABLE_TEXT_FIELDS_ = ['name', 'email', 'dept', 'note'];

function adminList_(token) {
  requireAdmin_(token);
  const accounts = readAccounts_().rows.map(row => {
    const user = publicUser_(row);
    return Object.assign(user, { active: row.active, note: String(row.note || '') });
  });
  accounts.sort((a, b) => (a.active === b.active ? (a.account < b.account ? -1 : 1) : (a.active ? -1 : 1)));
  return { accounts, systems: SYSTEMS };
}

/**
 * 新增或修改一個帳號。isNew 決定是新增還是修改，避免打錯帳號時不小心蓋掉別人的資料。
 */
function adminSave_(token, input, isNew, password) {
  const me = requireAdmin_(token);
  const data = validateAccountInput_(input || {});
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new AuthError('LOCK', '系統忙碌中，請稍後再試');
  try {
    const table = readAccounts_();
    const existing = table.rows.filter(r => normAccount_(r.account) === data.account)[0];
    if (isNew) {
      if (existing) throw new AuthError('VALIDATION', '帳號「' + data.account + '」已經存在');
      assertPassword_(password);
    } else {
      if (!existing) throw new AuthError('NOT_FOUND', '找不到帳號「' + data.account + '」');
      // 管理者不能停用自己或拿掉自己的管理權限，否則最後一位管理者會把自己鎖在外面。
      if (data.account === normAccount_(me.account) && (!data.active || !data.admin)) {
        throw new AuthError('VALIDATION', '不能停用自己或移除自己的管理權限，請由另一位管理者操作');
      }
    }

    const values = table.header.map(h => {
      if (h === 'account') return existing ? existing.account : data.account;
      if (h === 'password') return existing ? existing.password : String(password);
      if (h === 'active') return data.active;
      if (h === 'admin') return data.admin;
      if (EDITABLE_TEXT_FIELDS_.indexOf(h) !== -1) return data[h];
      if (SYSTEM_COLUMNS.indexOf(h) !== -1) return data.roles[h] || '';
      return existing ? existing[h] : '';
    });
    const sheet = sheet_();
    const rowNumber = existing ? existing.rowNumber : sheet.getLastRow() + 1;
    sheet.getRange(rowNumber, 1, 1, values.length).setValues([values]);
    const saved = findAccount_(data.account);
    return Object.assign(publicUser_(saved), { active: saved.active, note: String(saved.note || '') });
  } finally {
    lock.releaseLock();
  }
}

function adminResetPassword_(token, account, password) {
  requireAdmin_(token);
  assertPassword_(password);
  const key = normAccount_(account);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new AuthError('LOCK', '系統忙碌中，請稍後再試');
  try {
    const row = findAccount_(key);
    if (!row) throw new AuthError('NOT_FOUND', '找不到帳號「' + key + '」');
    sheet_().getRange(row.rowNumber, row.columns.password).setValue(String(password));
    // 重設後解除鎖定：同事通常是輸錯太多次才來找管理者。
    clearFails_(key);
    return { account: row.account };
  } finally {
    lock.releaseLock();
  }
}

function requireAdmin_(token) {
  const row = activeAccountFor_(token);
  if (!row.admin) throw new AuthError('FORBIDDEN', '只有帳號管理員可以管理帳號');
  return row;
}

function validateAccountInput_(input) {
  const account = normAccount_(input.account);
  if (!ACCOUNT_PATTERN_.test(account)) {
    throw new AuthError('VALIDATION', '帳號只能用 2–32 個英文小寫、數字或 . _ -');
  }
  const out = { account, active: input.active === true, admin: input.admin === true, roles: {} };
  EDITABLE_TEXT_FIELDS_.forEach(f => { out[f] = String(input[f] == null ? '' : input[f]).trim(); });
  if (!out.name) throw new AuthError('VALIDATION', '請填姓名');
  // email 用來對應各系統的負責人欄位，格式錯了工作台就找不到這個人的待辦。
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new AuthError('VALIDATION', 'email 格式不正確');
  out.email = out.email.toLowerCase();
  const roles = input.roles || {};
  SYSTEMS.forEach(s => {
    const role = String(roles[s.id] == null ? '' : roles[s.id]).trim();
    if (role && s.roles.indexOf(role) === -1) {
      throw new AuthError('VALIDATION', s.name + '沒有「' + role + '」這個角色');
    }
    out.roles[s.id] = role;
  });
  return out;
}

function assertPassword_(password) {
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('VALIDATION', '密碼至少 ' + MIN_PASSWORD_LENGTH + ' 個字元');
  }
}
