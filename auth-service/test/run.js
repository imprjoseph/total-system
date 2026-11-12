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
  });
  const sheet = {
    getDataRange: () => ({ getValues: () => values.map(row => row.slice()) }),
    getRange: range,
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
  ['Code.js', 'Setup.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8'), ctx, { filename: f }));
  props.TOKEN_SECRET = 'test-secret';

  const header = vm.runInContext('BASE_COLUMNS.concat(SYSTEM_COLUMNS)', ctx);
  const rowOf = (o) => header.map(h => (h in o ? o[h] : ''));
  values = [header,
    rowOf({ account: 'Amy', password: '0123ab', name: '王小美', active: true, 'activity-tracker': 'pm', resource: 'staff' }),
    rowOf({ account: 'bob', password: 'secret1', name: '陳大寶', active: '是' }),
    rowOf({ account: 'gone', password: 'secret2', name: '離職者', active: false, resource: 'admin' }),
  ];

  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, post, props, cache, writes, setActive: (r, v) => { values[r][header.indexOf('active')] = v; } };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('登入成功：帳號不分大小寫，回傳憑證與角色', () => {
  const { post } = makeContext();
  const r = post({ action: 'login', account: '  amy ', password: '0123ab' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.user.name, '王小美');
  assert.deepStrictEqual({ ...r.data.user.roles }, { 'activity-tracker': 'pm', resource: 'staff' });
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
  assert.strictEqual(post({ action: 'verify', token, system: 'impr-attendance' }).error.code, 'FORBIDDEN');
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
