import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.CFNEW_ALLOW_PRIVATE = 'yes';
const { createPanelServer } = await import('../server.mjs');
const { createSubscriptionEngine } = await import('../engine.mjs');
import { TEST_PASSWORD, forwardHeaders } from './auth-helpers.mjs';
const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const source = await readFile(process.env.CFNEW_TEST_CORE || new URL('../../明文源吗', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, (_, name) => 'const ' + name.trim() + ' = () => { throw new Error("此测试不建立代理连接"); };')).toString('base64'))).default;
const initial = { ev: 'yes', et: 'no', ex: 'no', ena: 'no', epd: 'no', epi: 'yes', egi: 'no', ae: 'yes' };
const entries = Array.from({ length: 950 }, (_, i) => `104.16.${Math.floor(i / 250)}.${i % 250 + 1}:443#优选节点-${i + 1}-香港`);

async function fixture(run, upstreamError = false) {
  const values = new Map([['c', JSON.stringify(initial)]]);
  const storage = { get: async (key, type) => type === 'json' ? JSON.parse(values.get(key) || 'null') : values.get(key), put: async (key, value) => values.set(key, value) };
  const core = createServer(async (incoming, outgoing) => {
    if (upstreamError) { outgoing.writeHead(502, { 'Content-Type': 'text/html' }); outgoing.end('<html>upstream unavailable</html>'); return; }
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await worker.fetch(new Request('http://worker.example' + incoming.url, { method: incoming.method, headers: forwardHeaders(incoming), ...(body.length ? { body } : {}) }), { u: uuid, C: storage });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
  });
  const panel = createPanelServer();
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => panel.listen(0, '127.0.0.1', resolve));
  const host = 'http://127.0.0.1:' + core.address().port;
  const origin = 'http://127.0.0.1:' + panel.address().port;
  const api = origin + '/worker-api/' + Buffer.from(host).toString('base64url') + '/' + uuid;
  // Phase 1 ③：经真实 HTTP 面板设密码并登录，取会话 cookie 与订阅令牌（故障模拟除外）。
  // 登录放在 try 内：登录失败时仍须关服务器，否则测试进程因监听 socket 永不退出。
  let cookie = '';
  let token = '';
  try {
    if (!upstreamError) {
      const setup = await fetch(api + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
      if (![200, 409].includes(setup.status)) throw new Error('setup 失败：' + setup.status + ' ' + await setup.text());
      const loginRes = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
      if (loginRes.status !== 200) throw new Error('登录失败：' + loginRes.status + ' ' + await loginRes.text());
      const setCookie = (loginRes.headers.getSetCookie?.() || [])[0] || loginRes.headers.get('set-cookie');
      cookie = setCookie.split(';')[0];
      token = (await (await fetch(api + '/api/auth/sub-token', { headers: { Cookie: cookie } })).json()).token;
    }
    await run({ api, host, origin, values, cookie, token });
  }
  finally { await Promise.all([core, panel].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))); }
}

test('950条带中文备注的优选经真实HTTP保存、回读并完整生成订阅', async () => fixture(async ({ api, origin, host, values, cookie, token }) => {
  const yx = entries.join('\r\n');
  const response = await fetch(api + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ yx }) });
  const result = await response.json();
  assert.equal(response.status, 200, result.message);
  assert.equal(result.success, true);
  assert.equal(JSON.parse(values.get('c')).yx, yx);
  assert.equal((await (await fetch(api + '/api/config', { headers: { Cookie: cookie } })).json()).yx, yx);
  const subscription = await fetch(origin + '/sub/' + token + '?' + new URLSearchParams({ host, uuid, target: 'base64' }));
  assert.equal(subscription.status, 200);
  const nodes = atob(await subscription.text()).trim().split('\n');
  assert.equal(nodes.length, entries.length, '不能把换行列表当成单个节点或丢失条目');
  assert.ok(nodes.some(node => node.includes('104.16.3.200:443')));
}));

test('低于32KiB的长字段也可保存，避免只扩大网关上限', async () => fixture(async ({ api, cookie }) => {
  const yx = Array.from({ length: 950 }, (_, i) => `104.16.${Math.floor(i / 250)}.${i % 250 + 1}:443#node`).join(',');
  assert.ok(yx.length > 16384 && Buffer.byteLength(JSON.stringify({ yx })) < 32768);
  const response = await fetch(api + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ yx }) });
  assert.equal(response.status, 200, await response.text());
}));

test('换行、回车与逗号混排同时兼容订阅与优选管理API', async () => fixture(async ({ api, origin, host, cookie, token }) => {
  const yx = '104.16.1.1:443#四版\r\n[2606:4700::1111]:8443#六版,example.com:2053#域名\r104.16.2.2:443#回车';
  assert.equal((await fetch(api + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ yx, epd: 'yes' }) })).status, 200);
  const list = await (await fetch(api + '/api/preferred-ips', { headers: { Cookie: cookie } })).json();
  assert.equal(list.count, 4);
  const sub = await fetch(origin + '/sub/' + token + '?' + new URLSearchParams({ host, uuid }));
  const nodes = atob(await sub.text()).trim().split('\n').map(node => new URL(node));
  assert.equal(nodes.length, 4);
  assert.ok(nodes.some(node => node.hostname === '[2606:4700::1111]' && node.port === '8443'));
  assert.ok(nodes.some(node => node.hostname === 'example.com' && node.port === '2053'));
}));

test('配置超过请求上限时返回明确JSON错误且不落库', async () => fixture(async ({ api, values }) => {
  const before = values.get('c');
  const response = await fetch(api + '/api/config', { method: 'POST', body: JSON.stringify({ yx: 'a'.repeat(1048576) }) });
  assert.equal(response.status, 413);
  const result = await response.json();
  assert.equal(result.success, false); assert.match(result.message, /过大|过长|上限/);
  assert.equal(values.get('c'), before);
}));

test('优选列表字段上限与普通字段上限仍然有效', async () => fixture(async ({ api, values, cookie }) => {
  for (const body of [{ yx: 'a'.repeat(262145) }, { d: 'a'.repeat(16385) }]) {
    const before = values.get('c');
    const response = await fetch(api + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(body) });
    assert.ok(!response.ok);
    const result = await response.json(); assert.equal(result.success, false); assert.ok(result.message);
    assert.equal(values.get('c'), before);
  }
}));

test('Worker返回HTML故障页时网关返回JSON且保留错误状态', async () => fixture(async ({ api }) => {
  const response = await fetch(api + '/api/config', { method: 'POST', body: '{}' });
  assert.equal(response.status, 502);
  const result = await response.json(); assert.equal(result.success, false);
  assert.match(result.message, /502/); assert.ok(!result.message.includes('<html>'));
}, true));

test('前端保存遇到413或HTML时显示可读错误且不会重载或假报成功', async () => {
  const engine = createSubscriptionEngine(initial, uuid);
  const html = await (await engine.render(new Request('https://worker.example/' + uuid))).text();
  const fn = html.match(/async function 保存配置\([^]*?(?=\nfunction 显示状态)/)[0];
  for (const status of [413, 502, 200]) {
    let message;
    const save = new Function('fetch', 'window', '显示状态', '加载当前配置', '更新工作器地区状态', 'setTimeout', fn + '; return 保存配置;')(
      async () => new Response('<html>error</html>', { status }), { CFNEW: { apiBase: '/test' } },
      value => { message = value; }, () => assert.fail('失败不能重载配置'), () => assert.fail('失败不能更新状态'), () => assert.fail('失败不能刷新页面'));
    await assert.rejects(save({ yx: '104.16.1.1:443' }), error => !(error instanceof SyntaxError));
    assert.match(message, status === 413 ? /过大|过长|URL/ : /响应|格式|502/);
  }
});


test('接近优选字段上限的中文内容可完整往返，不被响应上限截断', async () => fixture(async ({ api, values, cookie }) => {
  const prefix = '104.16.1.1:443#';
  const yx = prefix + '测'.repeat(262144 - prefix.length);
  const response = await fetch(api + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ yx }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.yx.length, yx.length);
  assert.equal((await (await fetch(api + '/api/config', { headers: { Cookie: cookie } })).json()).yx.length, yx.length);
  assert.equal(JSON.parse(values.get('c')).yx.length, yx.length);
}));
