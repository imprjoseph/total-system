/**
 * 在 Node 裡用模擬的 Apps Script 服務跑帳號中心，驗證登入、鎖定、憑證、停用與改密碼。
 * 執行：node auth-service/test/run.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeContext() {
  const props = {};
  const cache = {};
  let values = [];
  const writes = [];

  const range = (r, c) => ({
    setValue(v) { values[r - 1][c - 1] = v; writes.push([r, c, v]); },
    setValues(rows) { values[r - 1] = rows[0].slice(); writes.push([r, c, rows[0]]); },
  });
  const sheet = {
    getDataRange: () => ({ getValues: () => values.map(row => row.slice()) }),
    getRange: range,
    getLastRow: () => values.length,
  };

  const Utilities = {
    computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac('sha256', key).update(value, 'utf8').digest()),
    base64EncodeWebSafe: (data) => Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.map(b => b & 0xff))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64DecodeWebSafe: (s) => Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    getUuid: () => crypto.randomUUID(),
    Charset: { UTF_8: 'UTF-8' },
  };

  const ctx = {
    console: { log() {}, error() {} },
    Utilities,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  };
  vm.createContext(ctx);
  ['Code.js', 'Admin.js', 'Setup.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8'), ctx, { filename: f }));
  props.TOKEN_SECRET = 'test-secret';

  const header = vm.runInContext('BASE_COLUMNS.concat(SYSTEM_COLUMNS)', ctx);
  const rowOf = (o) => header.map(h => (h in o ? o[h] : ''));
  values = [header,
    rowOf({ account: 'Amy', password: '0123ab', name: '王小美', active: true, 'activity-tracker': 'pm', resource: 'staff',
      'impr-attendance': 'staff', manager: 'Boss', email: 'amy@example.com', dept: '專案部' }),
    rowOf({ account: 'bob', password: 'secret1', name: '陳大寶', active: '是' }),
    rowOf({ account: 'gone', password: 'secret2', name: '離職者', active: false, resource: 'admin' }),
    rowOf({ account: 'boss', password: 'boss123', name: '管理者', active: true, admin: true, email: 'boss@example.com', 'impr-attendance': 'admin' }),
    // 試算表被手動填了其他系統角色和 admin，也不能生效。
    rowOf({ account: 'pt01', password: 'ptpass1', name: '派遣甲', type: '派遣', active: true, admin: true,
      'PT-member': 'staff', 'activity-tracker': 'pm', resource: 'admin' }),
  ];

  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, post, props, cache, writes, header, values: () => values, setActive: (r, v) => { values[r][header.indexOf('active')] = v; } };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('登入成功：帳號不分大小寫，回傳憑證與角色', () => {
  const { post } = makeContext();
  const r = post({ action: 'login', account: '  amy ', password: '0123ab' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.user.name, '王小美');
  assert.deepStrictEqual({ ...r.data.user.roles }, { 'activity-tracker': 'pm', resource: 'staff', 'impr-attendance': 'staff' });
  assert.match(r.data.token, /^[\w-]+\.[\w-]+$/);
});

test('密碼錯誤與帳號不存在回同一句話', () => {
  const { post } = makeContext();
  const a = post({ action: 'login', account: 'amy', password: 'wrong' });
  const b = post({ action: 'login', account: 'nobody', password: 'wrong' });
  assert.strictEqual(a.error.code, 'AUTH');
  assert.strictEqual(a.error.message, b.error.message);
});

test('連錯 5 次鎖定，鎖定時正確密碼也不能登入', () => {
  const { post } = makeContext();
  for (let i = 0; i < 5; i++) post({ action: 'login', account: 'amy', password: 'x' });
  const r = post({ action: 'login', account: 'amy', password: '0123ab' });
  assert.strictEqual(r.error.code, 'LOCKED');
});

test('登入成功後清除失敗次數', () => {
  const { post, cache } = makeContext();
  post({ action: 'login', account: 'amy', password: 'x' });
  post({ action: 'login', account: 'amy', password: '0123ab' });
  assert.strictEqual(cache['fail:amy'], undefined);
});

test('停用帳號不能登入；手打「是」視為啟用', () => {
  const { post } = makeContext();
  assert.strictEqual(post({ action: 'login', account: 'gone', password: 'secret2' }).error.code, 'DISABLED');
  assert.ok(post({ action: 'login', account: 'bob', password: 'secret1' }).ok);
});

test('me：換發憑證；帳號停用後立即失效', () => {
  const { post, setActive } = makeContext();
  const { token } = post({ action: 'login', account: 'amy', password: '0123ab' }).data;
  assert.ok(post({ action: 'me', token }).ok);
  setActive(1, false);
  assert.strictEqual(post({ action: 'me', token }).error.code, 'DISABLED');
});

test('竄改憑證內容被拒絕', () => {
  const { post } = makeContext();
  const { token } = post({ action: 'login', account: 'bob', password: 'secret1' }).data;
  const [body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  payload.roles = { resource: 'admin' };
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.' + sig;
  assert.strictEqual(post({ action: 'me', token: forged }).error.code, 'TOKEN');
});

test('換了密鑰後舊憑證失效', () => {
  const { post, ctx } = makeContext();
  const { token } = post({ action: 'login', account: 'bob', password: 'secret1' }).data;
  ctx.rotateSecret();
  assert.strictEqual(post({ action: 'me', token }).error.code, 'TOKEN');
});

test('逾時憑證被拒絕', () => {
  const { post, ctx } = makeContext();
  const { token } = post({ action: 'login', account: 'bob', password: 'secret1' }).data;
  // vm 有自己的 Date，要改的是 context 內的 Date.now。
  vm.runInContext('Date.__realNow = Date.now; Date.now = () => Date.__realNow() + 13 * 3600 * 1000;', ctx);
  assert.strictEqual(post({ action: 'me', token }).error.code, 'TOKEN');
});

test('verify：有角色回傳角色，沒角色 FORBIDDEN，未知系統 VALIDATION', () => {
  const { post } = makeContext();
  const { token } = post({ action: 'login', account: 'amy', password: '0123ab' }).data;
  assert.strictEqual(post({ action: 'verify', token, system: 'activity-tracker' }).data.role, 'pm');
  assert.strictEqual(post({ action: 'verify', token, system: 'PT-member' }).error.code, 'FORBIDDEN');
  assert.strictEqual(post({ action: 'verify', token, system: 'nope' }).error.code, 'VALIDATION');
});

test('改密碼：舊密碼錯拒絕；太短拒絕；成功後新密碼可登入、舊密碼不行', () => {
  const { post, writes } = makeContext();
  const { token } = post({ action: 'login', account: 'bob', password: 'secret1' }).data;
  assert.strictEqual(post({ action: 'changePassword', token, oldPassword: 'x', newPassword: 'newpass1' }).error.code, 'AUTH');
  assert.strictEqual(post({ action: 'changePassword', token, oldPassword: 'secret1', newPassword: '123' }).error.code, 'VALIDATION');
  assert.ok(post({ action: 'changePassword', token, oldPassword: 'secret1', newPassword: 'newpass1' }).ok);
  assert.strictEqual(writes.length, 1);
  assert.ok(post({ action: 'login', account: 'bob', password: 'newpass1' }).ok);
  assert.strictEqual(post({ action: 'login', account: 'bob', password: 'secret1' }).error.code, 'AUTH');
});

test('改密碼連錯 5 次也會鎖定，且鎖住登入', () => {
  const { post } = makeContext();
  const { token } = post({ action: 'login', account: 'bob', password: 'secret1' }).data;
  for (let i = 0; i < 5; i++) post({ action: 'changePassword', token, oldPassword: 'guess' + i, newPassword: 'newpass1' });
  assert.strictEqual(post({ action: 'changePassword', token, oldPassword: 'secret1', newPassword: 'newpass1' }).error.code, 'LOCKED');
  assert.strictEqual(post({ action: 'login', account: 'bob', password: 'secret1' }).error.code, 'LOCKED');
});

// ---------- 帳號管理 ----------
const tokenOf = (post, account, password) => post({ action: 'login', account, password }).data.token;
const newHire = { account: 'Carol', name: '林小卡', email: 'Carol@Example.com', dept: '設計部', active: true, admin: false,
  roles: { 'ai-design': 'designer', resource: '' } };

test('[管理] 非管理員不能使用帳號管理', () => {
  const { post } = makeContext();
  const token = tokenOf(post, 'amy', '0123ab');
  assert.strictEqual(post({ action: 'admin.list', token }).error.code, 'FORBIDDEN');
  assert.strictEqual(post({ action: 'admin.save', token, account: newHire, isNew: true, password: 'carol123' }).error.code, 'FORBIDDEN');
});

test('[管理] 清單含所有帳號與角色選項，但不含密碼', () => {
  const { post } = makeContext();
  const data = post({ action: 'admin.list', token: tokenOf(post, 'boss', 'boss123') }).data;
  assert.strictEqual(data.accounts.length, 5);
  assert.ok(data.accounts.every(a => !('password' in a)));
  assert.strictEqual(data.accounts[data.accounts.length - 1].account, 'gone', '停用帳號排最後');
  assert.deepStrictEqual(data.systems.find(s => s.id === 'ai-design').roles, ['admin', 'designer', 'staff']);
});

test('[管理] 新增帳號後可登入，帳號轉小寫、email 轉小寫、角色寫入', () => {
  const { post } = makeContext();
  const token = tokenOf(post, 'boss', 'boss123');
  const r = post({ action: 'admin.save', token, account: newHire, isNew: true, password: 'carol123' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.account, 'carol');
  assert.strictEqual(r.data.email, 'carol@example.com');
  const login = post({ action: 'login', account: 'carol', password: 'carol123' });
  assert.deepStrictEqual(login.data.user.roles, { 'ai-design': 'designer' });
});

test('[管理] 新增時帳號重複、密碼太短、帳號格式錯、無效角色、缺姓名都被拒絕', () => {
  const { post } = makeContext();
  const token = tokenOf(post, 'boss', 'boss123');
  const save = (acc, pw) => post({ action: 'admin.save', token, account: Object.assign({}, newHire, acc), isNew: true, password: pw || 'longpass' }).error;
  assert.match(save({ account: 'AMY' }).message, /已經存在/);
  assert.match(save({}, '123').message, /至少/);
  assert.match(save({ account: '王小美' }).message, /英文小寫/);
  assert.match(save({ roles: { 'ai-design': 'mangaer' } }).message, /沒有「mangaer」/);
  assert.match(save({ name: '  ' }).message, /姓名/);
  assert.match(save({ email: 'not-an-email' }).message, /email/);
});

test('[管理] 修改帳號：保留密碼與帳號原樣，更新角色與狀態，修改不存在的帳號被拒絕', () => {
  const { post } = makeContext();
  const token = tokenOf(post, 'boss', 'boss123');
  const r = post({ action: 'admin.save', token, isNew: false,
    account: { account: 'amy', name: '王小美', active: true, admin: false, roles: { 'activity-tracker': 'staff' } } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.data.roles, { 'activity-tracker': 'staff' }, 'resource 角色被清掉');
  assert.ok(post({ action: 'login', account: 'amy', password: '0123ab' }).ok, '密碼沒被動到');
  assert.strictEqual(post({ action: 'admin.save', token, isNew: false, account: Object.assign({}, newHire) }).error.code, 'NOT_FOUND');
});

test('[管理] 停用帳號後，該帳號既有憑證立刻失效', () => {
  const { post } = makeContext();
  const amyToken = tokenOf(post, 'amy', '0123ab');
  post({ action: 'admin.save', token: tokenOf(post, 'boss', 'boss123'), isNew: false,
    account: { account: 'amy', name: '王小美', active: false, roles: {} } });
  assert.strictEqual(post({ action: 'me', token: amyToken }).error.code, 'DISABLED');
});

test('[管理] 管理者不能停用自己或拿掉自己的管理權限', () => {
  const { post } = makeContext();
  const token = tokenOf(post, 'boss', 'boss123');
  const self = { account: 'boss', name: '管理者', active: true, admin: true, roles: {} };
  assert.match(post({ action: 'admin.save', token, isNew: false, account: Object.assign({}, self, { admin: false }) }).error.message, /不能停用自己/);
  assert.match(post({ action: 'admin.save', token, isNew: false, account: Object.assign({}, self, { active: false }) }).error.message, /不能停用自己/);
  assert.ok(post({ action: 'admin.save', token, isNew: false, account: Object.assign({}, self, { dept: '管理部' }) }).ok);
});

test('[管理] 重設密碼：新密碼可登入，並解除鎖定', () => {
  const { post } = makeContext();
  for (let i = 0; i < 5; i++) post({ action: 'login', account: 'bob', password: 'x' });
  const r = post({ action: 'admin.resetPassword', token: tokenOf(post, 'boss', 'boss123'), account: 'BOB', password: 'reset99' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(post({ action: 'login', account: 'bob', password: 'reset99' }).ok);
});

test('[管理] 憑證帶 admin 旗標（入口網站據此顯示帳號管理連結）', () => {
  const { post } = makeContext();
  assert.strictEqual(post({ action: 'login', account: 'boss', password: 'boss123' }).data.user.admin, true);
  assert.strictEqual(post({ action: 'login', account: 'amy', password: '0123ab' }).data.user.admin, false);
});

// ---------- 派遣人員 ----------
test('[派遣] 只保留派遣系統角色，admin 不生效；憑證也帶類型', () => {
  const { post } = makeContext();
  const r = post({ action: 'login', account: 'pt01', password: 'ptpass1' });
  assert.deepStrictEqual(r.data.user.roles, { 'PT-member': 'staff' });
  assert.strictEqual(r.data.user.admin, false);
  assert.strictEqual(r.data.user.type, '派遣');
  const payload = JSON.parse(Buffer.from(r.data.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.strictEqual(payload.type, '派遣');
  assert.strictEqual(payload.admin, false);
});

test('[派遣] 其他系統驗證一律 FORBIDDEN，派遣系統可以通過', () => {
  const { post } = makeContext();
  const token = tokenOf(post, 'pt01', 'ptpass1');
  assert.strictEqual(post({ action: 'verify', token, system: 'activity-tracker' }).error.code, 'FORBIDDEN');
  assert.strictEqual(post({ action: 'verify', token, system: 'resource' }).error.code, 'FORBIDDEN');
  assert.strictEqual(post({ action: 'verify', token, system: 'PT-member' }).data.role, 'staff');
});

test('[派遣] 派遣帳號不能用帳號管理', () => {
  const { post } = makeContext();
  assert.strictEqual(post({ action: 'admin.list', token: tokenOf(post, 'pt01', 'ptpass1') }).error.code, 'FORBIDDEN');
});

test('[派遣] 管理頁不能幫派遣帳號設其他系統角色或 admin；只設派遣系統可以', () => {
  const { post } = makeContext();
  const token = tokenOf(post, 'boss', 'boss123');
  const base = { account: 'pt02', name: '派遣乙', type: '派遣', active: true, admin: false, roles: { 'PT-member': 'staff' } };
  const save = acc => post({ action: 'admin.save', token, isNew: true, password: 'ptpass2', account: Object.assign({}, base, acc) });
  assert.match(save({ roles: { 'PT-member': 'staff', 'activity-tracker': 'staff' } }).error.message, /只能使用派遣人員勤務/);
  assert.match(save({ admin: true }).error.message, /不能當帳號管理員/);
  assert.match(save({ type: '外包' }).error.message, /正職或派遣/);
  const ok = save({});
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.strictEqual(ok.data.type, '派遣');
});

test('[派遣] 類型空白視為正職，既有帳號不受影響', () => {
  const { post } = makeContext();
  const r = post({ action: 'login', account: 'amy', password: '0123ab' });
  assert.strictEqual(r.data.user.type, '正職');
  assert.strictEqual(r.data.user.roles['activity-tracker'], 'pm');
});

// ---------- 直屬主管與人員名單 ----------
test('[主管] 帳號帶直屬主管（轉小寫），管理頁可設定、不能設自己或不存在的帳號', () => {
  const { post } = makeContext();
  assert.strictEqual(post({ action: 'login', account: 'amy', password: '0123ab' }).data.user.manager, 'boss');
  const token = tokenOf(post, 'boss', 'boss123');
  const save = manager => post({ action: 'admin.save', token, isNew: false, account: { account: 'bob', name: '陳大寶', active: true, manager, roles: {} } });
  assert.match(save('bob').error.message, /不能是自己/);
  assert.match(save('nobody').error.message, /找不到直屬主管/);
  assert.strictEqual(save('AMY').data.manager, 'amy');
});

test('[名單] 系統管理員可讀該系統人員名單：只含有角色、啟用中的人，不含密碼', () => {
  const { post } = makeContext();
  const r = post({ action: 'directory', token: tokenOf(post, 'boss', 'boss123'), system: 'impr-attendance' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.data.users.map(u => u.account).sort(), ['amy', 'boss']);
  const amy = r.data.users.find(u => u.account === 'amy');
  assert.deepStrictEqual({ ...amy }, { account: 'amy', name: '王小美', email: 'amy@example.com', dept: '專案部', manager: 'boss', role: 'staff' });
});

test('[名單] 一般同仁、派遣、未知系統都不能讀名單', () => {
  const { post } = makeContext();
  assert.strictEqual(post({ action: 'directory', token: tokenOf(post, 'amy', '0123ab'), system: 'impr-attendance' }).error.code, 'FORBIDDEN');
  assert.strictEqual(post({ action: 'directory', token: tokenOf(post, 'pt01', 'ptpass1'), system: 'impr-attendance' }).error.code, 'FORBIDDEN');
  assert.strictEqual(post({ action: 'directory', token: tokenOf(post, 'boss', 'boss123'), system: 'x' }).error.code, 'VALIDATION');
});

test('格式錯誤與未知動作回 VALIDATION，不洩漏內部錯誤', () => {
  const { ctx, post } = makeContext();
  assert.strictEqual(JSON.parse(ctx.doPost({ postData: { contents: '{bad' } }).text).error.code, 'VALIDATION');
  assert.strictEqual(post({ action: 'drop' }).error.code, 'VALIDATION');
});

test('憑證內容可由瀏覽器端解出中文姓名（sso.js 的解碼方式）', () => {
  const { post } = makeContext();
  const { token } = post({ action: 'login', account: 'amy', password: '0123ab' }).data;
  const p = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '==='.slice(0, (4 - p.length % 4) % 4));
  const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  assert.strictEqual(payload.name, '王小美');
  assert.strictEqual(payload.sub, 'amy');
});

let failed = 0;
tests.forEach(t => {
  try { t.fn(); console.log('PASS ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n  ' + e.message); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
