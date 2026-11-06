import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSubscriptionEngine } from '../engine.mjs';
import { normalizeWorker } from '../server.mjs';
import { isPublicAddress, normalizePreferredList } from '../preferred.mjs';
import { loginWorkerSession } from './auth-helpers.mjs';

const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const otherUuid = '67f889ca-63fc-4aee-9454-6a33cf4c9466';
const fixture = { yx: '104.16.1.1:443#测试,104.16.1.2:80#明文,[2606:4700::1111]:8443#六版', epi: 'yes', epd: 'no', egi: 'no', ena: 'no', ev: 'yes', et: 'yes', ex: 'yes', kvEnabled: true };
const source = await readFile(process.env.CFNEW_TEST_CORE || new URL('../../明文源吗', import.meta.url), 'utf8');
const module = await import('data:text/javascript;base64,' + Buffer.from(source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, (_, name) => 'const ' + name.trim() + ' = () => { throw new Error("测试中不应建立连接"); };')).toString('base64'));
const worker = module.default;
function memoryKV(config = {}) {
  const values = new Map([['c', JSON.stringify(config)]]);
  return { get: async (key, type) => type === 'json' ? JSON.parse(values.get(key) || 'null') : values.get(key), put: async (key, value) => values.set(key, value) };
}
const req = (path, init) => new Request('https://worker.example' + path, init);
// Phase 1 ③：直调 Worker 管理接口须带会话；返回一个已登录的调用函数。
async function authedFetch(env, id = uuid) {
  const token = await loginWorkerSession((path, init) => worker.fetch(req(path, init), env), id);
  return (path, init = {}) => worker.fetch(req(path, { ...init, headers: { ...(init.headers || {}), 'X-CFNEW-SESSION': token } }), env);
}

test('Worker 首页和订阅路径没有页面或订阅生成', async () => {
  assert.equal(await (await worker.fetch(req('/'))).text(), 'hello');
  assert.equal((await worker.fetch(req('/' + uuid + '/sub'), { u: uuid })).status, 404);
  assert.ok(!source.includes('<html') && !source.includes('function 处理订阅请求') && !source.includes('function 生成值值数据对象'));
});

test('UUID 配置接口严格鉴权，并返回环境变量与 KV 的有效配置', async () => {
  const env = { u: uuid, s: 'http://proxy.example:8080', ET: 'yes', c: memoryKV({ qj: 'only', d: '/custom/nested' }) };
  assert.equal((await worker.fetch(req('/wrong/api/config'), env)).status, 404);
  assert.equal((await worker.fetch(req('/api/config'), env)).status, 404);
  assert.equal((await worker.fetch(req('/wrong/api/config', { method: 'POST', body: '{"qj":"no"}' }), env)).status, 404);
  assert.equal((await worker.fetch(req('/' + uuid + '/api/config'), env)).status, 401, '无会话读配置应被拒');
  const call = await authedFetch(env);
  const response = await call('/' + uuid + '/api/config');
  const config = await response.json();
  assert.equal(config.s, env.s); assert.equal(config.et, 'yes'); assert.equal(config.qj, 'only'); assert.equal(config.kvEnabled, true);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call('/custom/nested/api/config')).status, 200);
});

test('配置保存、清空、非法输入以及优选地址增删均按真实 API 执行', async () => {
  const env = { u: uuid, c: memoryKV({ ae: 'yes', yx: '104.16.1.1:443#旧值' }) };
  const call = await authedFetch(env);
  let response = await call('/' + uuid + '/api/config', { method: 'POST', body: '{"qj":"only","et":"yes"}' });
  assert.equal((await response.json()).success, true);
  assert.equal((await (await call('/' + uuid + '/api/config')).json()).qj, 'only');
  response = await call('/' + uuid + '/api/config', { method: 'POST', body: '{"qj":""}' });
  assert.equal((await response.json()).config.qj, '');
  assert.equal((await call('/' + uuid + '/api/config', { method: 'POST', body: '{"__proto__":{}}' })).status, 400);
  response = await call('/' + uuid + '/api/preferred-ips', { method: 'POST', body: '{"ip":"104.16.1.2","port":8443,"name":"新增"}' });
  assert.equal((await response.json()).added, 1);
  response = await call('/' + uuid + '/api/preferred-ips', { method: 'DELETE', body: '{"ip":"104.16.1.2","port":8443}' });
  assert.equal((await response.json()).success, true);
});

test('未绑定 KV 时管理接口不可用，订阅生成仍走引擎直调', async () => {
  // ③ 下无 KV 即无处存密码/会话/令牌，管理接口一律 401；订阅生成不经过 Worker 鉴权。
  const env = { U: uuid, YX: '104.16.1.1:443', ET: 'yes' };
  assert.equal((await worker.fetch(req('/' + uuid + '/api/config'), env)).status, 401);
  assert.equal((await worker.fetch(req('/' + uuid + '/api/config', { method: 'POST', body: '{}' }), env)).status, 401);
  const engine = createSubscriptionEngine({ ev: 'yes', et: 'yes', ex: 'no', yx: env.YX, epi: 'yes', epd: 'no', egi: 'no', ena: 'no' }, uuid);
  const sub = await (await engine.subscribe(new Request('https://worker.example/' + uuid + '/sub'))).text();
  assert.ok(atob(sub).includes('104.16.1.1:443'));
});

test('并发 Worker 与订阅实例不会串用 UUID、KV 或域名', async () => {
  const results = await Promise.all([uuid, otherUuid].map(async (id, index) => {
    // 改后 core 的 epi 默认 'no'（2026-11-05 替换：关 uouin 拉取）；epi 是优选地址总开关，
    // 不显式开它自定义 yx 不生成节点。本测试要的是优选地址节点，故显式 epi: 'yes'。
    const config = await (await worker.fetch(req('/' + id + '/api/config'), { u: id, c: memoryKV({ yx: '104.16.1.' + (index + 1) + ':443', epi: 'yes' }) })).json();
    const engine = createSubscriptionEngine(config, id);
    return atob(await (await engine.subscribe(new Request('https://worker' + index + '.example/' + id + '/sub'))).text());
  }));
  assert.ok(results[0].includes(uuid) && !results[0].includes(otherUuid));
  assert.ok(results[1].includes(otherUuid) && !results[1].includes(uuid));
  assert.ok(results[0].includes('worker0.example') && !results[0].includes('worker1.example'));
});

test('所有主分支客户端格式都生成真实节点，保留 TLS、路径和三种协议', async () => {
  for (const target of ['base64', 'v2ray', 'clash', 'stash', 'surge', 'loon', 'quanx', 'singbox']) {
    const engine = createSubscriptionEngine({ ...fixture, d: '/my/path' }, uuid);
    const response = await engine.subscribe(new Request('https://worker.example/' + uuid + '/sub?target=' + target));
    assert.equal(response.status, 200, target);
    let body = await response.text();
    if (['base64', 'v2ray'].includes(target)) body = atob(body);
    assert.ok(body.includes('worker.example'), target);
    assert.ok(body.includes('104.16.1.1'), target);
    if (target === 'singbox') JSON.parse(body);
    if (target === 'base64') { assert.ok(body.includes('vless://') && body.includes('trojan://') && body.includes('xhttp')); assert.equal(new URL(body.split('\n')[0]).searchParams.get('path'), '/?ed=2048'); }
  }
});

test('主分支家宽开关保留，关闭时返回 403', async () => {
  const engine = createSubscriptionEngine({ ...fixture, jk: 'no' }, uuid);
  assert.equal((await engine.subscribe(new Request('https://worker.example/sub?target=vg'))).status, 403);
});

test('独立页面的订阅和 API 地址分离，脚本无语法错误', async () => {
  const engine = createSubscriptionEngine(fixture, uuid);
  const html = await (await engine.render(new Request('https://worker.example/' + uuid))).text();
  assert.ok(html.includes('window.CFNEW.subUrl') && html.includes('window.CFNEW.apiBase'));
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
});

test('连接参数拒绝非 HTTPS、用户信息和带路径地址', () => {
  assert.equal(normalizeWorker('worker.example'), 'https://worker.example');
  for (const value of ['http://worker.example', 'https://user:pass@worker.example', 'https://worker.example/path', 'https://worker.example?token=one']) assert.throws(() => normalizeWorker(value));
});

test('旧面板地址字段兼容，同时仍拒绝未定义字段', async () => {
  const env = { u: uuid, c: memoryKV() };
  const call = await authedFetch(env);
  const response = await call('/' + uuid + '/api/config', { method: 'POST', body: '{"customIP":"104.16.1.1:443","yx":"104.16.1.2:8443#优选"}' });
  assert.equal(response.status, 200);
  const config = await (await call('/' + uuid + '/api/config')).json();
  assert.equal(config.p, '104.16.1.1:443'); assert.equal(config.yx, '104.16.1.2:8443#优选');
  assert.equal((await call('/' + uuid + '/api/config', { method: 'POST', body: '{"unknown":"value"}' })).status, 400);
});

test('手填域名、IPv4和IPv6显式端口在各客户端格式中保留', async () => {
  const config = { ...fixture, epd: 'yes', yx: 'edge.example:8443#域名,104.16.1.1:2053#四版,[2606:4700::1111]:2096#六版' };
  const response = await createSubscriptionEngine(config, uuid).subscribe(req('/' + uuid + '/sub'));
  const nodes = atob(await response.text()).split('\n').map(line => new URL(line));
  assert.ok(nodes.filter(node => node.hostname === 'edge.example').every(node => node.port === '8443'));
  assert.ok(nodes.some(node => node.hostname === '104.16.1.1' && node.port === '2053'));
  assert.ok(nodes.some(node => node.hostname.includes('2606:4700') && node.port === '2096'));
});

test('优选服务拒绝私网、映射回环地址与IPv6文档网段', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('104.16.1.1'), true); assert.equal(isPublicAddress('2606:4700::1111'), true);
});

test('在线CSV保留端口、IPv6和备注，并跳过非TLS行', () => {
  const csv = 'IP地址,端口,数据中心,国家,TLS\n104.16.1.1,8443,SJC,美国,true\n2606:4700::1111,2053,SIN,新加坡,true\n104.16.2.2,80,SIN,新加坡,false';
  assert.equal(normalizePreferredList(csv), '104.16.1.1:8443#美国\n[2606:4700::1111]:2053#新加坡');
  assert.equal(normalizePreferredList('# 注释\n104.16.1.1:443,edge.example:8443'), '104.16.1.1:443\nedge.example:8443');
});

test('生成的XHTTP短路径及客户端尾斜杠能进入传输，短路径不能访问配置API', async () => {
  const response = await createSubscriptionEngine(fixture, uuid).subscribe(req('/' + uuid + '/sub'));
  const link = atob(await response.text()).split('\n').map(line => new URL(line)).find(node => node.searchParams.get('type') === 'xhttp');
  assert.equal(link.searchParams.get('mode'), 'stream-one');
  assert.equal(link.searchParams.get('alpn'), 'h2');
  const path = link.searchParams.get('path');
  const result = await worker.fetch(req(path + '/', { method: 'POST', body: new Uint8Array([0]) }), { u: uuid, ex: 'yes' });
  assert.equal(result.status, 502, '不完整首包应由传输解析拒绝，不能因为路由不匹配返回404');
  assert.equal((await worker.fetch(req(path + '/api/config'), { u: uuid })).status, 404);
});
