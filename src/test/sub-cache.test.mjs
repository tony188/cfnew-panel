// Phase 1 ② 回归测试：/sub 按配置版本缓存 + 并发合并 + yxURL TTL。
// 只用本地测试 UUID、本地 yxURL 假源与本地假 Worker，不含任何真实 UUID。
// 计数口径：yxCount 为 yxURL 假源收到的实际 HTTP 请求次数。
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// yxURL 假源：按预设剧本回包并计数。script 为函数 (n) => body，n 为第几次请求。
async function startYxServer(script, delayMs = 0) {
  let count = 0;
  const server = createServer((incoming, outgoing) => {
    count++;
    const n = count;
    const send = () => { outgoing.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); outgoing.end(script(n)); };
    if (delayMs > 0) setTimeout(send, delayMs); else send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/list.txt',
    count: () => count,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function fixture(run, { yxBody, yxDelayMs = 0, yxScript = null } = {}) {
  const { store, kv } = makeKv();
  const yx = await startYxServer(yxScript || (() => yxBody), yxDelayMs);
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
  const apiBase = '/worker-api/' + Buffer.from(host).toString('base64url') + '/' + uuid;
  const call = (path, init) => handlePanel(new Request('https://panel.example' + apiBase + path, init));
  const panel = (path, init) => handlePanel(new Request('https://panel.example' + path, init));
  try { await run({ host, query, store, kv, call, panel, yx }); }
  finally { await yx.close(); await new Promise(resolve => server.close(resolve)); }
}

// 登录并把 yxURL 配成假源，返回会话 cookie 与订阅令牌。
async function setupSub({ call, panel, query, yx }, extraConfig = {}) {
  const cookie = await loginCookie(call);
  const saved = await call('/api/config', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ egi: 'yes', yxURL: yx.url, yx: '', ...extraConfig }) });
  assert.equal(saved.status, 200, await saved.text());
  const token = await fetchSubToken(call, cookie);
  const sub = (t = token, target = 'base64', init = {}) => panel('/sub/' + t + '?' + query + '&target=' + target, init);
  return { call, panel, query, cookie, token, sub, yx };
}

async function subBody(sub, ...args) {
  const res = await sub(...args);
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  return { res, text: Buffer.from(raw, 'base64').toString('utf8') };
}

// base64 订阅解码后各链接的 server 主机名。原生节点（ena=yes）的 server 是 Worker 地址
//（测试里为 127.0.0.1）；优选域名/yxURL 节点的 server 是各自的域名或 IP。
function linkHostnames(text) {
  return text.trim().split('\n').filter(Boolean).map(line => new URL(line).hostname);
}

const PLAIN_LIST = '1.1.1.1:443#优选甲\n2.2.2.2:443#优选乙';

test('两次 /sub 第二次命中缓存，yxURL 只拉一次', async () => fixture(async (ctx) => {
  const { sub, yx } = await setupSub(ctx);
  const first = await subBody(sub);
  assert.equal(first.res.headers.get('x-cfnew-sub-cache'), 'MISS');
  assert.equal(yx.count(), 1, '第一次生成应恰好拉 yxURL 一次');
  assert.ok(first.text.includes('1.1.1.1') && first.text.includes('2.2.2.2'), '订阅应含 yxURL 节点');
  const second = await subBody(sub);
  assert.equal(second.res.headers.get('x-cfnew-sub-cache'), 'HIT');
  assert.equal(yx.count(), 1, '第二次应命中缓存，不再拉 yxURL');
  assert.equal(second.text, first.text, '命中缓存内容应一致');
}, { yxBody: PLAIN_LIST }));

test('并发 5 路同键 /sub 只生成一次', async () => fixture(async (ctx) => {
  const { sub, yx } = await setupSub(ctx);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => subBody(sub)));
  for (const r of results) assert.equal(r.res.status, 200);
  assert.ok(results.every(r => r.text === results[0].text), '并发各路订阅内容应一致');
  assert.equal(yx.count(), 1, '并发 5 路应只拉 yxURL 一次');
}, { yxBody: PLAIN_LIST, yxDelayMs: 100 }));

test('改配置后 /sub 立即失效、内容更新，且不重拉 yxURL', async () => fixture(async (ctx) => {
  const { call, cookie, sub, yx } = await setupSub(ctx);
  const before = await subBody(sub);
  assert.equal(before.res.headers.get('x-cfnew-sub-cache'), 'MISS');
  const beforeHosts = linkHostnames(before.text);
  assert.ok(!beforeHosts.includes('127.0.0.1'), '改前不应有原生节点');
  const saved = await call('/api/config', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ena: 'yes' }) });
  const savedText = await saved.text();
  assert.equal(saved.status, 200, savedText);
  assert.equal(JSON.parse(savedText).configVersion, 2, '改配置后版本应 +1');
  const after = await subBody(sub);
  assert.equal(after.res.headers.get('x-cfnew-sub-cache'), 'MISS', '版本一改即失效，应重新生成');
  const afterHosts = linkHostnames(after.text);
  assert.ok(afterHosts.includes('127.0.0.1'), '改后应含原生节点');
  assert.equal(afterHosts.length, beforeHosts.length + 2, '改后应多原生节点的 :80 与 :443 两条链接');
  assert.notEqual(after.text, before.text, '改后内容应更新');
  assert.equal(yx.count(), 1, '重新生成应复用 yxURL 缓存，不重拉');
}, { yxBody: PLAIN_LIST }));

test('不同令牌与不同 target 的缓存项互不串用', async () => fixture(async (ctx) => {
  const { call, cookie, token, sub, yx } = await setupSub(ctx);
  const base64 = await subBody(sub);
  assert.equal(base64.res.headers.get('x-cfnew-sub-cache'), 'MISS');
  const clashRes = await sub(token, 'clash');
  const clashText = await clashRes.text();
  assert.equal(clashRes.status, 200, clashText);
  assert.equal(clashRes.headers.get('x-cfnew-sub-cache'), 'MISS', '不同 target 应是另一缓存项');
  assert.notEqual(clashText, base64.text, '不同 target 内容应不同');
  assert.ok(clashText.includes('proxies:'), 'clash 格式应为 YAML');
  const again = await subBody(sub);
  assert.equal(again.res.headers.get('x-cfnew-sub-cache'), 'HIT', '回到 base64 应命中原缓存项');
  assert.equal(yx.count(), 1, '换 target 不应重拉 yxURL');
  const rotated = await call('/api/auth/rotate-sub-token', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rotated.status, 200);
  const newToken = (await rotated.json()).token;
  const rotatedRes = await subBody(sub, newToken);
  assert.equal(rotatedRes.res.headers.get('x-cfnew-sub-cache'), 'MISS', '轮换令牌后新作用域应重新生成');
  assert.equal(rotatedRes.text, base64.text, '轮换后节点内容应不变');
  assert.equal((await sub(token)).status, 401, '旧令牌订阅应失效');
}, { yxBody: PLAIN_LIST }));

test('/sub TTL 过期后重新生成', async () => fixture(async (ctx) => {
  process.env.CFNEW_SUB_TTL_MS = '80';
  try {
    const { sub, yx } = await setupSub(ctx);
    const first = await subBody(sub);
    assert.equal(first.res.headers.get('x-cfnew-sub-cache'), 'MISS');
    await sleep(120);
    const second = await subBody(sub);
    assert.equal(second.res.headers.get('x-cfnew-sub-cache'), 'MISS', 'TTL 过期后应重新生成');
    assert.equal(second.text, first.text, 'TTL 过期重生成内容应一致');
    assert.equal(yx.count(), 1, '重生成仍应复用 yxURL 缓存');
  } finally { delete process.env.CFNEW_SUB_TTL_MS; }
}, { yxBody: PLAIN_LIST }));

test('yxURL TTL 过期后重新拉取', async () => fixture(async (ctx) => {
  process.env.CFNEW_YXURL_TTL_MS = '80';
  try {
    const { call, cookie, sub, yx } = await setupSub(ctx);
    const first = await subBody(sub);
    assert.equal(yx.count(), 1, '第一次生成应拉 yxURL 一次');
    const saved = await call('/api/config', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ena: 'yes' }) });
    assert.equal(saved.status, 200, await saved.text());
    await sleep(120);
    const second = await subBody(sub);
    assert.equal(second.res.headers.get('x-cfnew-sub-cache'), 'MISS', '版本已改应重新生成');
    assert.equal(yx.count(), 2, 'yxURL TTL 过期后重新生成应重拉一次');
    assert.ok(linkHostnames(second.text).includes('127.0.0.1'), '重生成内容应含新配置的原生节点');
    assert.ok(second.text.includes('1.1.1.1'), '重拉后 yxURL 节点仍在');
  } finally { delete process.env.CFNEW_YXURL_TTL_MS; }
}, { yxBody: PLAIN_LIST }));

test('yxURL 二次 fetch 合并为一次：接口返回空时回退复用已拉文本', async () => fixture(async (ctx) => {
  const { sub, yx } = await setupSub(ctx);
  const { res, text } = await subBody(sub);
  assert.equal(res.headers.get('x-cfnew-sub-cache'), 'MISS');
  // CSV 表头无已知列 → 获取优选接口返回空，触发回退分支；回退须复用已拉文本，不再拉取。
  assert.equal(yx.count(), 1, '一次订阅生成对同一 yxURL 源最多拉一次');
  assert.ok(text.includes('2.2.2.2') && text.includes('3.3.3.3'), '回退分支仍应解析出节点');
}, { yxBody: 'foo,bar\n2.2.2.2:443#乙\n3.3.3.3:443#丙' }));

test('失败生成不进缓存：家宽未开的 403 两次均为 MISS', async () => fixture(async (ctx) => {
  const { sub } = await setupSub(ctx);
  const first = await sub(undefined, 'vg');
  assert.equal(first.status, 403);
  assert.equal(first.headers.get('x-cfnew-sub-cache'), 'MISS');
  const second = await sub(undefined, 'vg');
  assert.equal(second.status, 403);
  assert.equal(second.headers.get('x-cfnew-sub-cache'), 'MISS', '失败响应不得被缓存为 HIT');
}, { yxBody: PLAIN_LIST }));

test('yxURL 空结果不缓存、有效结果进缓存', async () => {
  const { createSubscriptionEngine } = await import('../engine.mjs');
  // 前两次拉取返回空，第三次返回有效列表，之后又返回空。
  // 若空结果被缓存，第二次订阅拿不到节点；若有效结果未缓存，第三次订阅会重拉。
  const yx = await startYxServer(n => (n <= 2 ? '' : n === 3 ? PLAIN_LIST : ''));
  try {
    const config = { ena: 'no', ev: 'yes', et: 'no', ex: 'no', egi: 'yes', yxURL: yx.url, yx: '' };
    const run = async () => {
      const res = await createSubscriptionEngine(config, uuid).subscribe(new Request('https://worker.example/' + uuid + '/sub?target=base64'));
      assert.equal(res.status, 200);
      return Buffer.from(await res.text(), 'base64').toString('utf8');
    };
    const first = await run();
    assert.ok(!first.includes('1.1.1.1'), '空源第一次订阅应无 yxURL 节点');
    assert.equal(yx.count(), 2, '空源时接口拉取 + 回退复用应共拉两次（回退不命中空缓存）');
    const second = await run();
    assert.ok(second.includes('1.1.1.1'), '空结果不缓存，第二次订阅应拿到有效节点');
    assert.equal(yx.count(), 3, '第二次订阅应重拉一次');
    const third = await run();
    assert.ok(third.includes('1.1.1.1'), '有效结果进缓存，第三次订阅仍应有节点');
    assert.equal(yx.count(), 3, '第三次订阅应命中 yxURL 缓存，不再拉取');
  } finally { await yx.close(); }
});
