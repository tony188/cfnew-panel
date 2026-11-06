import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test, { after } from 'node:test';

process.env.CFNEW_ALLOW_PRIVATE = 'yes';
const { handlePanel } = await import('../server.mjs');

// 测试 UUID（仅本地测试用，不含任何真实 UUID）。
const uuidA = '166c5e95-001b-445c-8c13-bac9d1bfdc86';
const uuidB = '351c9981-04b6-4103-aa4b-864aa9c91469';

const source = await readFile(process.env.CFNEW_TEST_CORE || './test/core-fixture.mjs', 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, (_, name) => 'const ' + name.trim() + ' = () => { throw new Error("此测试不建立代理连接"); };')).toString('base64'))).default;

// 多键 KV 模拟（真实 KV 语义：按 key 存取，支持 list/delete）。
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

function callWorker(uuid, kv, path, method = 'GET', body) {
  const request = new Request('https://worker.example/' + uuid + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(request, { u: uuid, C: kv });
}

async function callJson(uuid, kv, path, method = 'GET', body) {
  const response = await callWorker(uuid, kv, path, method, body);
  return { status: response.status, json: await response.json() };
}

// ---------- A 组：core 直测 ----------
const { store: storeA, kv: kvA } = makeKv();

test('A1 空 KV 首次 GET：版本 0、无快照', async () => {
  const { status, json } = await callJson(uuidA, kvA, '/api/config');
  assert.equal(status, 200);
  assert.equal(json.configVersion, 0);
  assert.deepEqual(json.snapshots, []);
  assert.equal(json.ena, 'no');
});

test('A2 POST 改 ena 一项：版本 +1、快照 1 份、其余字段不变', async () => {
  const { status, json } = await callJson(uuidA, kvA, '/api/config', 'POST', { ena: 'yes' });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.configVersion, 1);
  assert.equal(json.prevVersion, 0);
  assert.deepEqual(json.changedKeys, ['ena']);
  assert.deepEqual(json.snapshots.map(s => s.version), [1, 0]);
  assert.equal(json.config.ena, 'yes');
  assert.equal(json.config.ech, 'no');
  assert.equal(json.config.epd, 'yes');
  const snap0 = JSON.parse(storeA.get('c_snap:0'));
  assert.equal(snap0.version, 0);
  // 新鲜 KV 的 c 本就是 {}，v0 快照如实存 {}；生效时读侧补默认值（回滚行为见 A5）。
  assert.deepEqual(snap0.config, {});
  assert.equal(JSON.parse(storeA.get('c')).ena, 'yes');
});

test('A3 无改动 POST：不烧版本', async () => {
  const { status, json } = await callJson(uuidA, kvA, '/api/config', 'POST', { ena: 'yes' });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.configVersion, 1);
  assert.equal(json.message, '没有改动，无需保存');
  assert.deepEqual(json.changedKeys, []);
});

test('A4 POST ech=yes：版本 2；回滚到 v1 得版本 3、ech 回 no', async () => {
  const saved = await callJson(uuidA, kvA, '/api/config', 'POST', { ech: 'yes' });
  assert.equal(saved.json.configVersion, 2);
  assert.equal(saved.json.config.ech, 'yes');
  const rolled = await callJson(uuidA, kvA, '/api/config/rollback', 'POST', { targetVersion: 1 });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.json.configVersion, 3);
  assert.equal(rolled.json.rolledBackTo, 1);
  assert.equal(rolled.json.rolledBackFrom, 2);
  assert.equal(rolled.json.config.ech, 'no');
  assert.equal(rolled.json.config.ena, 'yes');
  const back = await callJson(uuidA, kvA, '/api/config');
  assert.equal(back.json.configVersion, 3);
  assert.equal(back.json.ech, 'no');
});

test('A5 回滚到 v0：版本 4、ena 回 no', async () => {
  const { status, json } = await callJson(uuidA, kvA, '/api/config/rollback', 'POST', { targetVersion: 0 });
  assert.equal(status, 200);
  assert.equal(json.configVersion, 4);
  assert.equal(json.config.ena, 'no');
  assert.equal(json.config.ech, 'no');
});

test('A6 非法回滚被拒：回滚到当前版、未来版、坏请求', async () => {
  assert.equal((await callJson(uuidA, kvA, '/api/config/rollback', 'POST', { targetVersion: 4 })).status, 400);
  assert.equal((await callJson(uuidA, kvA, '/api/config/rollback', 'POST', { targetVersion: 99 })).status, 400);
  assert.equal((await callJson(uuidA, kvA, '/api/config/rollback', 'POST', { targetVersion: -1 })).status, 400);
  const bad = await callWorker(uuidA, kvA, '/api/config/rollback', 'POST', undefined);
  assert.equal(bad.status, 400);
});

test('A7 客户端传版本字段被拒（版本只由 Worker 递增）', async () => {
  assert.equal((await callJson(uuidA, kvA, '/api/config', 'POST', { configVersion: 99 })).status, 400);
  assert.equal((await callJson(uuidA, kvA, '/api/config')).json.configVersion, 4);
});

test('A8 快照上限 5：连写 7 次后只剩最新 5 份，已裁剪的回滚报 404', async () => {
  for (let i = 1; i <= 7; i++) {
    const r = await callJson(uuidA, kvA, '/api/config', 'POST', { wk: 'w' + i });
    assert.equal(r.json.configVersion, 4 + i);
  }
  const snapKeys = [...storeA.keys()].filter(k => k.startsWith('c_snap:')).sort();
  assert.deepEqual(snapKeys, ['c_snap:10', 'c_snap:11', 'c_snap:7', 'c_snap:8', 'c_snap:9']);
  const { json } = await callJson(uuidA, kvA, '/api/config');
  assert.equal(json.snapshots.length, 5);
  assert.deepEqual(json.snapshots.map(s => s.version), [11, 10, 9, 8, 7]);
  assert.equal((await callJson(uuidA, kvA, '/api/config/rollback', 'POST', { targetVersion: 0 })).status, 404);
});

test('A9 迁移：无版本旧配置首次写入成 v1，v0 快照即旧配置', async () => {
  const { store, kv } = makeKv();
  // 旧配置：只有 c，无 c_meta（部署 ① 之前的形态）。
  await kv.put('c', JSON.stringify({ ena: 'yes', ech: 'no' }));
  const saved = await callJson(uuidA, kv, '/api/config', 'POST', { ech: 'yes' });
  assert.equal(saved.json.configVersion, 1);
  assert.deepEqual(saved.json.changedKeys, ['ech']);
  const snap0 = JSON.parse(store.get('c_snap:0'));
  assert.equal(snap0.config.ena, 'yes');
  assert.equal(snap0.config.ech, 'no');
  const rolled = await callJson(uuidA, kv, '/api/config/rollback', 'POST', { targetVersion: 0 });
  assert.equal(rolled.json.configVersion, 2);
  assert.equal(rolled.json.config.ena, 'yes');
  assert.equal(rolled.json.config.ech, 'no');
});

// ---------- B 组：面板代理 + /sub 节点数全程 ----------
const { kv: kvB } = makeKv();
const httpServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  const init = { method: req.method, headers: { 'Content-Type': 'application/json' } };
  if (body) init.body = body;
  const r = await worker.fetch(new Request('https://worker' + req.url, init), { u: uuidB, C: kvB });
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(await r.text());
});
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
process.env.w = 'http://127.0.0.1:' + httpServer.address().port;
after(async () => { httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); });

async function panel(path, method = 'GET', body) {
  const init = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handlePanel(new Request('https://panel.example/' + uuidB + path, init));
}

async function subNodeCount() {
  const res = await panel('/sub');
  assert.equal(res.status, 200);
  const lines = Buffer.from(await res.text(), 'base64').toString('utf8').split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length;
}

test('B1 基线 /sub 为 42 条', async () => {
  assert.equal(await subNodeCount(), 42);
});

test('B2 面板 POST ena=yes → v1，/sub 44 条', async () => {
  const res = await panel('/api/config', 'POST', { ena: 'yes' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.configVersion, 1);
  assert.deepEqual(json.changedKeys, ['ena']);
  assert.equal(await subNodeCount(), 44);
});

test('B3 面板 POST ech=yes → v2，/sub 22 条（ech→dkby 联动）', async () => {
  const res = await panel('/api/config', 'POST', { ech: 'yes' });
  const json = await res.json();
  assert.equal(json.configVersion, 2);
  assert.equal(await subNodeCount(), 22);
});

test('B4 面板回滚到 v1 → v3，/sub 回到 44 条', async () => {
  const res = await panel('/api/config/rollback', 'POST', { targetVersion: 1 });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.configVersion, 3);
  assert.equal(json.config.ech, 'no');
  assert.equal(await subNodeCount(), 44);
});

test('B5 面板回滚到 v0 → v4，/sub 回到 42 条；GET 带版本与快照', async () => {
  const res = await panel('/api/config/rollback', 'POST', { targetVersion: 0 });
  const json = await res.json();
  assert.equal(json.configVersion, 4);
  assert.equal(await subNodeCount(), 42);
  const got = await (await panel('/api/config')).json();
  assert.equal(got.configVersion, 4);
  assert.deepEqual(got.snapshots.map(s => s.version), [4, 3, 2, 1, 0]);
  assert.equal(got.ena, 'no');
});
