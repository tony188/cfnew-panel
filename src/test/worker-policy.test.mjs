import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.CFNEW_ALLOW_PRIVATE = 'yes';
const { handlePanel } = await import('../server.mjs');
import { loginCookie, fetchSubToken, forwardHeaders } from './auth-helpers.mjs';
const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const source = await readFile(process.env.CFNEW_TEST_CORE || new URL('../../明文源吗', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, (_, name) => 'const ' + name.trim() + ' = () => { throw new Error("隔离测试不建立代理连接"); };')).toString('base64'))).default;

async function fixture(run) {
  const previous = process.env.w;
  delete process.env.w;
  const servers = [];
  const targets = [];
  try {
    for (const name of ['指定', '其它']) {
      const values = new Map([['c', JSON.stringify({ d: '/Admin/Panel', ae: 'yes', yx: '104.16.1.1:443#' + name, ev: 'yes', epi: 'yes', epd: 'no', egi: 'no', ena: 'no' })]]);
      const target = { hits: 0, values };
      const storage = { get: async key => JSON.parse(values.get(key) || 'null'), put: async (key, value) => values.set(key, value) };
      const server = createServer(async (incoming, outgoing) => {
        target.hits++;
        const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const response = await worker.fetch(new Request('http://' + incoming.headers.host + incoming.url, { method: incoming.method, headers: forwardHeaders(incoming), ...(body.length ? { body } : {}) }), { u: uuid, C: storage });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      });
      servers.push(server);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      target.host = 'http://127.0.0.1:' + server.address().port;
      target.api = '/worker-api/' + Buffer.from(target.host).toString('base64url') + '/' + uuid;
      targets.push(target);
    }
    const request = (path, init) => handlePanel(new Request('https://panel.example' + path, init));
    const entry = (target, path = '/panel') => path + '?' + new URLSearchParams({ host: target.host, uuid });
    // Phase 1 ③：每台 Worker 各有自己的 KV/密码，登录与订阅令牌按目标取。
    const apiFor = target => '/worker-api/' + Buffer.from(target.host).toString('base64url') + '/' + uuid;
    const login = target => loginCookie((path, init) => request(apiFor(target) + path, init));
    const subToken = (target, cookie) => fetchSubToken((path, init) => request(apiFor(target) + path, init), cookie);
    const subUrl = (target, token, extra = '') => '/sub/' + token + '?' + new URLSearchParams({ host: target.host, uuid }) + extra;
    await run({ allowed: targets[0], other: targets[1], request, entry, login, subToken, subUrl });
  } finally {
    if (previous === undefined) delete process.env.w; else process.env.w = previous;
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  }
}

test('w留空或缺省时，不同Worker均可接入并生成订阅', async () => fixture(async ({ allowed, other, request, entry, login, subToken, subUrl }) => {
  for (const value of [undefined, '', '  ']) {
    if (value === undefined) delete process.env.w; else process.env.w = value;
    for (const target of [allowed, other]) {
      const cookie = await login(target);
      assert.equal((await request(entry(target), { headers: { Cookie: cookie } })).status, 200);
      const token = await subToken(target, cookie);
      assert.equal((await request(subUrl(target, token))).status, 200);
    }
  }
}));

test('绑定后首页无连接表单，指定Worker的读取、保存与六种订阅均成功', async () => fixture(async ({ allowed, request, entry, login, subToken, subUrl }) => {
  process.env.w = '  ' + allowed.host + '/  ';
  const html = await (await request('/')).text();
  assert.equal(html, 'hello');
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
  const cookie = await login(allowed);
  assert.equal((await request('/panel?' + new URLSearchParams({ uuid }), { headers: { Cookie: cookie } })).status, 200);
  const response = await request(allowed.api + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ yx: '104.16.1.2:443#保存名称' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.ok(allowed.values.get('c').includes('保存名称'));
  const token = await subToken(allowed, cookie);
  for (const target of ['base64', 'clash', 'singbox', 'surge', 'loon', 'quanx']) {
    const result = await request('/sub/' + token + '?target=' + target);
    assert.equal(result.status, 200, target);
  }
}));

test('其它Worker在页面、订阅、所有转发接口和优选服务均先被拒绝，未访问上游', async () => fixture(async ({ allowed, other, request, entry }) => {
  process.env.w = allowed.host;
  const attempts = [[entry(other)], [entry(other, '/sub')]];
  for (const suffix of ['/api/config', '/api/preferred-ips', '/region', '/test-api']) {
    for (const method of ['GET', 'POST', 'DELETE']) attempts.push([other.api + suffix, { method, ...(method !== 'GET' ? { body: '{}' } : {}) }]);
  }
  for (const path of ['/api/preferred/list', '/api/preferred/probe']) attempts.push([path, { method: 'POST', body: JSON.stringify({ host: other.host, uuid, url: 'https://example.com/list', address: '104.16.1.1', port: 443 }) }]);
  const before = other.values.get('c');
  for (const [path, init] of attempts) {
    const response = await request(path, { ...init, headers: { Origin: allowed.host, Referer: allowed.host, 'X-Forwarded-Host': new URL(allowed.host).host } });
    assert.equal(response.status, 403, path);
  }
  assert.equal(other.hits, 0);
  assert.equal(other.values.get('c'), before);
}));

test('公共模式已有配置缓存与优选鉴权缓存，绑定后仍不能跨Worker使用', async () => fixture(async ({ allowed, other, request, login }) => {
  const cookie = await login(other);
  assert.equal((await request(other.api + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: '{"yx":"104.16.1.3:443#缓存"}' })).status, 200);
  const payload = JSON.stringify({ host: other.host, uuid, url: '' });
  assert.equal((await request('/api/preferred/list', { method: 'POST', headers: { Cookie: cookie }, body: payload })).status, 400);
  const before = other.hits;
  process.env.w = allowed.host;
  assert.equal((await request(other.api + '/api/config')).status, 403);
  assert.equal((await request('/api/preferred/list', { method: 'POST', body: payload })).status, 403);
  assert.equal(other.hits, before);
}));

test('绑定配置无效时失败关闭，不泄露原值，清空后恢复公共模式', async () => fixture(async ({ other, request, entry }) => {
  for (const value of ['https://user:secret@worker.example', 'https://worker.example/path', 'https://worker.example?host=other', '不是域名/错误路径']) {
    process.env.w = value;
    for (const path of ['/', entry(other), entry(other, '/sub'), other.api + '/api/config']) {
      const response = await request(path);
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.ok(body.includes('w') && !body.includes('secret'));
    }
  }
  assert.equal(other.hits, 0);
  process.env.w = '';
  assert.equal((await request(entry(other))).status, 200);
}));

test('同域不同端口、域名后缀与URL凭据不能冒充指定Worker', async () => fixture(async ({ allowed, request }) => {
  process.env.w = allowed.host;
  for (const host of [allowed.host + '.evil.example', allowed.host.replace(/:\d+$/, ':1'), allowed.host.replace('://', '://user@')]) {
    const response = await request('/panel?' + new URLSearchParams({ host, uuid }));
    assert.notEqual(response.status, 200);
  }
  assert.equal(allowed.hits, 0);
}));


test('w绑定后通过UUID或多级自定义路径直进原控制台，生成原版API与订阅路径', async () => fixture(async ({ allowed, request, login }) => {
  process.env.w = allowed.host;
  const cookie = await login(allowed);
  for (const access of [uuid, uuid + '/', 'Admin/Panel']) {
    const response = await request('/' + access, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, access);
    const html = await response.text();
    assert.ok(!html.includes('id="host"'));
    const context = JSON.parse(html.match(/window\.CFNEW=(.*?);window\.CFNEW\.subUrl/)[1]);
    assert.equal(context.panelPath, '/' + uuid);
    assert.equal(context.apiBase, '/' + uuid);
    assert.match(context.subPath, /^\/sub\/[A-Za-z0-9_-]{32,64}$/, '订阅地址须为新形态 /sub/<令牌>');
    assert.equal(context.host, allowed.host);
    for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
  }
  assert.equal((await request('/Wrong/Path')).status, 404);
  assert.equal((await request('/' + uuid + '?' + new URLSearchParams({ host: 'https://not-allowed.example' }))).status, 403);
}));

test('原版路径配置保存、改入口、优选增删与六种订阅真实互通', async () => fixture(async ({ allowed, request, login, subToken }) => {
  process.env.w = allowed.host;
  const api = '/' + uuid;
  const cookie = await login(allowed);
  assert.equal((await request('/Admin/Panel/api/config', { headers: { Cookie: cookie } })).status, 200);
  const saved = await request(api + '/api/config', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ d: '/Changed/Entry', yx: '104.16.1.2:443#原版入口' }) });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).success, true);
  assert.ok(allowed.values.get('c').includes('Changed/Entry'));
  assert.equal((await request('/Admin/Panel')).status, 404);
  assert.equal((await request('/Changed/Entry', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request(api, { headers: { Cookie: cookie } })).status, 200);
  for (const suffix of ['/api/config', '/api/preferred-ips', '/region', '/test-api']) assert.equal((await request(api + suffix, { headers: { Cookie: cookie } })).status, 200, suffix);
  assert.equal((await request(api + '/api/preferred-ips', { method: 'POST', headers: { Cookie: cookie }, body: '{"ip":"104.16.1.3","port":443,"name":"新增"}' })).status, 200);
  assert.equal((await request(api + '/api/preferred-ips', { method: 'DELETE', headers: { Cookie: cookie }, body: '{"ip":"104.16.1.3","port":443}' })).status, 200);
  const token = await subToken(allowed, cookie);
  for (const target of ['base64', 'clash', 'singbox', 'surge', 'loon', 'quanx']) assert.equal((await request('/sub/' + token + '?target=' + target)).status, 200, target);
  assert.equal((await request('/sub/' + token)).status, 200);
  for (const path of ['/data/index.html', '/api/index.mjs', '/src/server.mjs', '/server.mjs', '/package.json', '/.env']) assert.notEqual((await request(path)).status, 200, path);
}));

test('公共模式保留域名登录，原版路径不擅自连接任一Worker', async () => fixture(async ({ allowed, request, entry }) => {
  const html = await (await request('/')).text();
  assert.ok(html.includes('id="host"'));
  assert.equal((await request('/' + uuid)).status, 404);
  assert.equal((await request('/Admin/Panel')).status, 404);
  assert.equal(allowed.hits, 0);
  assert.equal((await request(entry(allowed))).status, 200);
}));
