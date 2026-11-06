// Phase 1 ③ 回归测试：独立管理密码、管理会话、订阅令牌、分离、最小审计。
// 只用本地测试 UUID 与测试密码，不含任何真实 UUID。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { TEST_UUID, TEST_PASSWORD, loginCookie, fetchSubToken, forwardHeaders } from './auth-helpers.mjs';

process.env.CFNEW_ALLOW_PRIVATE = 'yes';
const { handlePanel } = await import('../server.mjs');
const uuid = TEST_UUID;
const source = await readFile(process.env.CFNEW_TEST_CORE || new URL('../../明文源吗', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, (_, name) => 'const ' + name.trim() + ' = () => { throw new Error("此测试不建立代理连接"); };')).toString('base64'))).default;

function makeKv() {
  const store = new Map();
  const kv = {
    get: async (key, type) => {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, typeof value === 'string' ? value : String(value)); },
    list: async ({ prefix } = {}) => ({ keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })) }),
    delete: async (key) => { store.delete(key); },
  };
  return { store, kv };
}

async function fixture(run) {
  const { store, kv } = makeKv();
  const server = createServer(async (incoming, outgoing) => {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await worker.fetch(new Request('http://127.0.0.1' + incoming.url, { method: incoming.method, headers: forwardHeaders(incoming), ...(body.length ? { body } : {}) }), { u: uuid, C: kv });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = 'http://127.0.0.1:' + server.address().port;
  const query = new URLSearchParams({ host, uuid }).toString();
  // call：经面板调 API（未绑定模式走 /worker-api/<b64(host)>/<uuid>/...）。
  const apiBase = '/worker-api/' + Buffer.from(host).toString('base64url') + '/' + uuid;
  const call = (path, init) => handlePanel(new Request('https://panel.example' + apiBase + path, init));
  const panel = (path, init) => handlePanel(new Request('https://panel.example' + path, init));
  try { await run({ host, query, store, kv, call, panel }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function subNodes(panel, query, token, target = 'base64') {
  const res = await panel('/sub/' + token + '?' + query + (target ? '&target=' + target : ''));
  if (res.status !== 200) assert.fail('订阅应成功：' + res.status + ' ' + await res.text());
  return Buffer.from(await res.text(), 'base64').toString('utf8').trim().split('\n').filter(Boolean);
}

test('未带会话调管理 API 被拒，凭 UUID 也进不去', async () => fixture(async ({ call }) => {
  for (const [path, init] of [
    ['/api/config', undefined],
    ['/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ['/api/config/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"targetVersion":0}' }],
    ['/api/auth/sub-token', undefined],
    ['/region', undefined],
  ]) {
    const res = await call(path, init);
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).success, false);
  }
}));

test('未登录时管理页渲染登录页，不渲染控制台', async () => fixture(async ({ panel, query }) => {
  const res = await panel('/panel?' + query);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('管理登录') || html.includes('设置管理密码'), '未认证应渲染登录页');
  assert.ok(!html.includes('window.CFNEW='), '未认证不得渲染控制台');
}));

test('错密码、短密码、重复设密码均被拒；登录响应种 HttpOnly 会话 cookie 且正文不含令牌', async () => fixture(async ({ call }) => {
  const short = await call('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'short' }) });
  assert.equal(short.status, 400);
  const setup = await call('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
  assert.equal(setup.status, 200, await setup.text());
  const again = await call('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
  assert.equal(again.status, 409);
  const wrong = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password-000' }) });
  assert.equal(wrong.status, 401);
  const login = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie.includes('cfnew_session='), '须种会话 cookie');
  assert.ok(setCookie.includes('HttpOnly'), 'cookie 须 HttpOnly');
  assert.ok(setCookie.includes('Path=/'), 'cookie 须 Path=/');
  assert.ok(setCookie.includes('Max-Age=43200'), 'cookie 须 Max-Age=43200（12 小时）');
  const body = await login.text();
  assert.ok(!body.includes('sessionToken'), '登录响应正文不得含会话令牌');
}));

test('密码在 KV 里是盐哈希不是明文', async () => fixture(async ({ call, store }) => {
  await call('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
  const raw = store.get('admin_pass');
  assert.ok(raw, 'KV 应有 admin_pass');
  assert.ok(!raw.includes(TEST_PASSWORD), 'KV 里不得出现密码明文');
  const record = JSON.parse(raw);
  assert.equal(record.alg, 'pbkdf2-sha256');
  assert.equal(record.iterations, 10000);
  assert.ok(typeof record.salt === 'string' && record.salt.length > 0);
  assert.ok(typeof record.hash === 'string' && record.hash.length > 0);
}));

test('带会话可读配置；会话过期后管理 API 被拒、管理页回登录页', async () => fixture(async ({ call, panel, query, store }) => {
  const cookie = await loginCookie(call);
  const ok = await call('/api/config', { headers: { Cookie: cookie } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).uuid, uuid);
  // 把 KV 里会话记录的过期时间改到过去，模拟闲置/绝对过期。
  const sessions = JSON.parse(store.get('auth_sessions'));
  const token = Object.keys(sessions)[0];
  sessions[token].lastSeenAt = Date.now() - 31 * 60 * 1000;
  sessions[token].expiresAt = Date.now() - 1000;
  store.set('auth_sessions', JSON.stringify(sessions));
  const expired = await call('/api/config', { headers: { Cookie: cookie } });
  assert.equal(expired.status, 401);
  const page = await panel('/panel?' + query, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('管理登录'), '过期会话访问管理页应回登录页');
}));

test('订阅令牌只能 GET /sub，调管理 API 被拒；管理会话调订阅无须令牌', async () => fixture(async ({ call, panel, query }) => {
  const cookie = await loginCookie(call);
  const token = await fetchSubToken(call, cookie);
  const nodes = await subNodes(panel, query, token);
  assert.ok(nodes.length > 0, '新订阅应有节点');
  assert.ok(nodes.every(line => new URL(line).username === uuid), '节点凭证仍为 UUID');
  // 令牌当会话调管理 API → 401。
  const asSession = await call('/api/config', { headers: { 'X-CFNEW-SESSION': token } });
  assert.equal(asSession.status, 401);
  // 会话当令牌调 /sub → 订阅失败（会话不是订阅令牌）。
  const sessionAsToken = await panel('/sub/' + cookie.split('=')[1] + '?' + query);
  assert.notEqual(sessionAsToken.status, 200);
  // 会话 cookie 不影响凭令牌取订阅（正交）。
  const withSession = await panel('/sub/' + token + '?' + query, { headers: { Cookie: cookie } });
  assert.equal(withSession.status, 200);
}));

test('轮换订阅令牌后旧 /sub 失效、新 /sub 可用、已导入节点凭证不变', async () => fixture(async ({ call, panel, query }) => {
  const cookie = await loginCookie(call);
  const oldToken = await fetchSubToken(call, cookie);
  const before = await subNodes(panel, query, oldToken);
  const rotated = await call('/api/auth/rotate-sub-token', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rotated.status, 200);
  const newToken = (await rotated.json()).token;
  assert.ok(newToken && newToken !== oldToken, '轮换应产生不同令牌');
  const oldSub = await panel('/sub/' + oldToken + '?' + query);
  assert.notEqual(oldSub.status, 200, '旧订阅地址轮换后应失效');
  const after = await subNodes(panel, query, newToken);
  assert.deepEqual(after, before, '轮换后节点凭证与节点列表应不变');
}));

test('撤销订阅令牌后订阅失效，再轮换可恢复', async () => fixture(async ({ call, panel, query }) => {
  const cookie = await loginCookie(call);
  const token = await fetchSubToken(call, cookie);
  assert.equal((await panel('/sub/' + token + '?' + query)).status, 200);
  const revoked = await call('/api/auth/revoke-sub-token', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(revoked.status, 200);
  assert.equal((await panel('/sub/' + token + '?' + query)).status, 401);
  const me = await call('/api/auth/sub-token', { headers: { Cookie: cookie } });
  assert.equal((await me.json()).token, null);
  const rotated = await call('/api/auth/rotate-sub-token', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rotated.status, 200);
  assert.equal((await panel('/sub/' + (await rotated.json()).token + '?' + query)).status, 200);
}));

test('旧 UUID 形态 /sub 一律被拒', async () => fixture(async ({ call, panel, query }) => {
  await loginCookie(call);
  assert.equal((await panel('/' + uuid + '/sub?' + query)).status, 404);
  assert.equal((await panel('/sub?' + query)).status, 404);
  assert.equal((await panel('/sub?uuid=' + uuid + '&host=http://127.0.0.1')).status, 404);
}));

test('改密码后旧会话失效、新密码可登录；登出后会话失效', async () => fixture(async ({ call }) => {
  const cookie = await loginCookie(call);
  const wrong = await call('/api/auth/change-password', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: 'wrong-password-000', newPassword: 'new-password-123456' }) });
  assert.equal(wrong.status, 401);
  const changed = await call('/api/auth/change-password', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: TEST_PASSWORD, newPassword: 'new-password-123456' }) });
  assert.equal(changed.status, 200);
  assert.equal((await call('/api/config', { headers: { Cookie: cookie } })).status, 401, '改密码后旧会话应失效');
  const relogin = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'new-password-123456' }) });
  assert.equal(relogin.status, 200);
  const newCookie = relogin.headers.get('set-cookie').split(';')[0];
  const logout = await call('/api/auth/logout', { method: 'POST', headers: { Cookie: newCookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'), '登出应清 cookie');
  assert.equal((await call('/api/config', { headers: { Cookie: newCookie } })).status, 401);
}));

test('忘密码恢复：删 KV 密码键后可重新设密码', async () => fixture(async ({ call, store }) => {
  await loginCookie(call);
  store.delete('admin_pass');
  const me = await call('/api/auth/me');
  assert.equal((await me.json()).passwordSet, false);
  const setup = await call('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'recovery-password-1' }) });
  assert.equal(setup.status, 200);
}));

test('最小审计记配置修改与令牌轮换/撤销，不记令牌明文', async () => fixture(async ({ call, store }) => {
  const cookie = await loginCookie(call);
  const saved = await call('/api/config', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ena: 'yes' }) });
  assert.equal(saved.status, 200);
  await call('/api/auth/rotate-sub-token', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  await call('/api/auth/revoke-sub-token', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  const log = JSON.parse(store.get('audit_log'));
  assert.ok(Array.isArray(log) && log.length >= 3);
  const ops = log.map(entry => entry.op);
  assert.ok(ops.includes('config.save'), '应记配置修改');
  assert.ok(ops.includes('token.rotate'), '应记令牌轮换');
  assert.ok(ops.includes('token.revoke'), '应记令牌撤销');
  for (const entry of log) {
    assert.ok(entry.at && entry.op && ['ok', 'fail'].includes(entry.result), '审计条目须有时间、操作、结果');
    assert.ok(!JSON.stringify(entry).includes('cfnew_session') && !JSON.stringify(entry).includes(TEST_PASSWORD), '审计不得记敏感值');
  }
}));
