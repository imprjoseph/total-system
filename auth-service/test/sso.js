/**
 * 在 Node 裡模擬瀏覽器載入 sso/sso.js，驗證解碼、逾時、導向與防外站跳轉。
 * 執行：node auth-service/test/sso.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SSO_SRC = fs.readFileSync(path.join(__dirname, '../../sso/sso.js'), 'utf8');
const ORIGIN = 'https://imprjoseph.github.io';

function load(href, fetchImpl) {
  const store = {};
  const location = {
    href, origin: new URL(href).origin,
    replaced: null,
    replace(url) { this.replaced = url; },
  };
  const window = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
  };
  const ctx = {
    window, location, URL, TextDecoder, atob, Uint8Array, JSON, Date, Object, String, Error,
    document: { currentScript: { src: ORIGIN + '/total-system/sso/sso.js' } },
    fetch: fetchImpl || (async () => { throw new Error('offline'); }),
  };
  vm.createContext(ctx);
  vm.runInContext(SSO_SRC, ctx);
  return { sso: window.ImprSSO, store, location };
}

function token(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.sig';
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('登入頁與入口網址由 sso.js 位置推算', () => {
  const { sso } = load(ORIGIN + '/activity/');
  assert.strictEqual(sso.LOGIN_URL, ORIGIN + '/total-system/login/');
  assert.strictEqual(sso.PORTAL_URL, ORIGIN + '/total-system/portal/');
});

test('getUser 解出中文姓名與角色', () => {
  const { sso, store } = load(ORIGIN + '/x/');
  store.impr_sso_token = token({ sub: 'amy', name: '王小美', roles: { resource: 'staff' }, exp: Date.now() / 1000 + 60 });
  const u = sso.getUser();
  assert.strictEqual(u.name, '王小美');
  assert.strictEqual(u.roles.resource, 'staff');
});

test('逾時或亂碼憑證視為未登入', () => {
  const { sso, store } = load(ORIGIN + '/x/');
  store.impr_sso_token = token({ sub: 'amy', exp: Date.now() / 1000 - 1 });
  assert.strictEqual(sso.getUser(), null);
  store.impr_sso_token = 'garbage';
  assert.strictEqual(sso.getUser(), null);
});

test('requireLogin：未登入導向登入頁並帶回原網址', () => {
  const { sso, location } = load(ORIGIN + '/resource/?tab=2');
  assert.strictEqual(sso.requireLogin(), null);
  assert.strictEqual(location.replaced, ORIGIN + '/total-system/login/?next=' + encodeURIComponent(ORIGIN + '/resource/?tab=2'));
});

test('safeNext 只接受同網域，外站一律回入口網站', () => {
  const { sso } = load(ORIGIN + '/total-system/login/');
  assert.strictEqual(sso.safeNext(ORIGIN + '/resource/'), ORIGIN + '/resource/');
  assert.strictEqual(sso.safeNext('/PT-member/'), ORIGIN + '/PT-member/');
  assert.strictEqual(sso.safeNext('https://evil.example/phish'), sso.PORTAL_URL);
  assert.strictEqual(sso.safeNext('//evil.example/phish'), sso.PORTAL_URL);
  assert.strictEqual(sso.safeNext('javascript:alert(1)'), sso.PORTAL_URL);
});

test('refresh：帳號停用時清掉憑證；網路錯誤時保留', async () => {
  const live = token({ sub: 'amy', exp: Date.now() / 1000 + 60 });
  const disabled = load(ORIGIN + '/x/', async () => ({ json: async () => ({ ok: false, error: { code: 'DISABLED', message: '停用' } }) }));
  disabled.store.impr_sso_token = live;
  await assert.rejects(disabled.sso.refresh(), e => e.code === 'DISABLED');
  assert.strictEqual(disabled.store.impr_sso_token, undefined);

  const offline = load(ORIGIN + '/x/');
  offline.store.impr_sso_token = live;
  await assert.rejects(offline.sso.refresh(), e => e.code === 'NETWORK');
  assert.strictEqual(offline.store.impr_sso_token, live);
});

test('login 成功後存下新憑證', async () => {
  const issued = token({ sub: 'amy', exp: Date.now() / 1000 + 60 });
  let sent;
  const { sso, store } = load(ORIGIN + '/x/', async (url, opts) => {
    sent = { url, opts };
    return { json: async () => ({ ok: true, data: { token: issued, user: { name: '王小美' } } }) };
  });
  const user = await sso.login('amy', 'pw');
  assert.strictEqual(user.name, '王小美');
  assert.strictEqual(store.impr_sso_token, issued);
  assert.strictEqual(sent.opts.headers, undefined, '不能設 Content-Type，否則觸發 CORS 預檢');
});

test('getUser 帶出 admin 旗標；request 自動附上憑證', async () => {
  let sent;
  const { sso, store } = load(ORIGIN + '/x/', async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { json: async () => ({ ok: true, data: { accounts: [] } }) };
  });
  store.impr_sso_token = token({ sub: 'boss', admin: true, exp: Date.now() / 1000 + 60 });
  assert.strictEqual(sso.getUser().admin, true);
  await sso.request('admin.list', { token: 'spoofed' });
  assert.strictEqual(sent.action, 'admin.list');
  assert.strictEqual(sent.token, store.impr_sso_token, '一律用目前憑證，呼叫端不能覆蓋');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n  ' + e.message); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
