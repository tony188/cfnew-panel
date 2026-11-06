import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.CFNEW_ALLOW_PRIVATE = 'yes';
const { handlePanel } = await import('../server.mjs');
import { TEST_PASSWORD, loginCookie, fetchSubToken, forwardHeaders } from './auth-helpers.mjs';
const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const source = await readFile(process.env.CFNEW_TEST_CORE || new URL('../../明文源吗', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, (_, name) => 'const ' + name.trim() + ' = () => { throw new Error("此测试不建立代理连接"); };')).toString('base64'))).default;

async function fixture(run, { legacy = false, kv = true, path = '/Admin/Panel' } = {}) {
  const values = new Map([['c', JSON.stringify({ d: path, ev: 'yes', et: 'yes', ex: 'yes', ena: 'no', epi: 'yes', epd: 'no', egi: 'no', yx: '104.16.1.1:443#测试' })]]);
  const storage = { get: async (key, type) => type === 'json' ? JSON.parse(values.get(key) || 'null') : values.get(key), put: async (key, value) => values.set(key, value) };
  const server = createServer(async (incoming, outgoing) => {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    // 旧内核模拟：没有 /api/auth/me（③ 的会话接口），配置接口无鉴权且不带 uuid。
    if (legacy && incoming.url.endsWith('/api/auth/me')) { outgoing.writeHead(404, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'Not Found' })); return; }
    if (legacy && incoming.method === 'GET' && incoming.url.endsWith('/api/config')) {
      const stored = JSON.parse(values.get('c') || '{}');
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ ...stored, kvEnabled: true }));
      return;
    }
    const response = await worker.fetch(new Request('http://127.0.0.1' + incoming.url, { method: incoming.method, headers: forwardHeaders(incoming), ...(body.length ? { body } : {}) }), { u: uuid, ...(kv ? { C: storage } : { d: path }) });
    let text = await response.text();
    if (legacy && response.ok && incoming.url.endsWith('/api/config') && incoming.method === 'GET') {
      const config = JSON.parse(text); delete config.uuid; text = JSON.stringify(config);
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(text);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = 'http://127.0.0.1:' + server.address().port;
  const panel = (access, endpoint = '/panel', init) => handlePanel(new Request('https://panel.example' + endpoint + '?' + new URLSearchParams({ host, uuid: access }), init));
  // call：经面板调 API（未绑定模式走 /worker-api/<b64(host)>/<access>/...）。
  const call = (access, path, init) => handlePanel(new Request('https://panel.example/worker-api/' + Buffer.from(host).toString('base64url') + '/' + access + path, init));
  const login = async access => loginCookie((path, init) => call(access, path, init));
  try { await run({ host, panel, call, login, values }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('域名加自定义多级路径能打开面板并解析真实UUID', async () => fixture(async ({ panel, login }) => {
  const cookie = await login('Admin/Panel');
  const response = await panel('/Admin/Panel/', '/panel', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200, '自定义路径不应被UUID格式校验拦截');
  const html = await response.text();
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
  const context = JSON.parse(html.match(/window\.CFNEW=(.*?);window\.CFNEW\.subUrl/)[1]);
  assert.equal(context.uuid, uuid);
  assert.ok(context.apiBase.endsWith('/' + uuid));
  assert.match(context.subPath, /^\/sub\/[A-Za-z0-9_-]{32,64}$/, '订阅地址须为新形态 /sub/<令牌>');
}));

test('自定义路径订阅使用真实UUID，所有协议节点都能正确鉴权', async () => fixture(async ({ panel, host, login, call }) => {
  const cookie = await login('Admin/Panel');
  const token = await fetchSubToken((path, init) => call('Admin/Panel', path, init), cookie);
  const response = await panel('Admin/Panel', '/sub/' + token);
  assert.equal(response.status, 200);
  const nodes = atob(await response.text()).trim().split('\n').map(link => new URL(link));
  assert.ok(nodes.some(node => node.searchParams.get('type') === 'xhttp'));
  assert.ok(nodes.some(node => node.protocol === 'trojan:'));
  assert.ok(nodes.filter(node => node.protocol === 'vless:').every(node => node.username === uuid));
}));

test('自定义路径大小写不可被改写，错误路径不能泄露UUID', async () => fixture(async ({ panel, host }) => {
  for (const path of ['admin/panel', 'Wrong/Path', '/api/config', '../Admin/Panel', 'Admin/Panel?x=1']) {
    const response = await panel(path);
    assert.equal(response.status, 400, path);
    assert.ok(!(await response.text()).includes(uuid), path);
  }
  const response = await fetch(host + '/wrong/api/config');
  assert.equal(response.status, 404); assert.ok(!(await response.text()).includes(uuid));
}));

test('旧内核无管理登录接口，UUID 与自定义路径入口均给出升级提示', async () => fixture(async ({ panel }) => {
  // ③ 下旧内核无法登录（无 /api/auth/me）；面板须明示升级，不再渲染半残控制台。
  for (const access of [uuid.toUpperCase(), 'Admin/Panel']) {
    const response = await panel(access);
    assert.equal(response.status, 400, access);
    assert.match(await response.text(), /升级.*内核|更新.*内核/, access);
  }
}, { legacy: true }));

test('没有KV也可通过环境变量自定义路径接入', async () => fixture(async ({ panel }) => {
  // 无 KV 时管理页渲染登录页（设密码页），状态 200；无处存密码，故到此为止。
  assert.equal((await panel('/Admin/Panel/')).status, 200);
}, { kv: false }));

test('路径接入后通过UUID保存新路径与优选，不影响后续配置和订阅', async () => fixture(async ({ panel, host, values, login, call }) => {
  const cookie = await login('Admin/Panel');
  assert.equal((await panel('Admin/Panel', '/panel', { headers: { Cookie: cookie } })).status, 200);
  const base = 'https://panel.example/worker-api/' + Buffer.from(host).toString('base64url') + '/' + uuid;
  const saved = await handlePanel(new Request(base + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ d: '/Changed/Entry', yx: '104.16.2.2:8443#新优选' }) }));
  assert.equal(saved.status, 200);
  const config = await (await handlePanel(new Request(base + '/api/config', { headers: { Cookie: cookie } }))).json();
  assert.equal(config.uuid, uuid); assert.equal(config.d, '/Changed/Entry');
  assert.equal(JSON.parse(values.get('c')).d, '/Changed/Entry');
  assert.equal((await panel('Changed/Entry', '/panel', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await panel('Admin/Panel')).status, 400);
  const token = await fetchSubToken((path, init) => call(uuid, path, init), cookie);
  const subscription = atob(await (await panel(uuid, '/sub/' + token)).text());
  assert.ok(subscription.includes('104.16.2.2:8443'));
}));


test('中文自定义路径与编码后的同一路径均可接入', async () => fixture(async ({ panel, login }) => {
  const cookie = await login('/管理/Panel/');
  assert.equal((await panel('/管理/Panel/', '/panel', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await panel(encodeURI('管理/Panel'), '/panel', { headers: { Cookie: cookie } })).status, 200);
}, { path: '/管理/Panel/' }));
