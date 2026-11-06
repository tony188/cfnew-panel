import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.CFNEW_ALLOW_PRIVATE = 'yes';
const { handlePanel } = await import('../server.mjs');
import { loginWorkerSession } from './auth-helpers.mjs';
const version = '2026.10.17.2';
const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const source = await readFile(process.env.CFNEW_TEST_CORE || new URL('../../明文源吗', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, (_, name) => 'const ' + name.trim() + ' = () => { throw new Error("此测试不建立代理连接"); };')).toString('base64'))).default;

test('核心声明只读版本，保存后继续回传且不写入KV', async () => {
  // ③ 后 KV 里有多个键（c/admin_pass/auth_sessions/...），迷你 KV 须按 key 存取。
  const store = new Map([['c', '{}']]);
  const env = { u: uuid, C: { get: async (key, type) => { if (!store.has(key)) return null; const raw = store.get(key); return type === 'json' ? JSON.parse(raw) : raw; }, put: async (key, value) => { store.set(key, typeof value === 'string' ? value : String(value)); } } };
  const token = await loginWorkerSession((path, init) => worker.fetch(new Request('https://worker.example' + path, init), env), uuid);
  const request = init => new Request('https://worker.example/' + uuid + '/api/config', { ...init, headers: { ...(init?.headers || {}), 'X-CFNEW-SESSION': token } });
  assert.equal((await (await worker.fetch(request(), env)).json()).coreVersion, version);
  const response = await worker.fetch(request({ method: 'POST', body: '{"yx":"104.16.1.1:443"}' }), env);
  assert.equal((await response.json()).config.coreVersion, version);
  assert.ok(!Object.hasOwn(JSON.parse(store.get('c')), 'coreVersion'));
  assert.equal((await worker.fetch(request({ method: 'POST', body: '{"coreVersion":"fake"}' }), env)).status, 400);
});

test('首页显示面板版本', async () => {
  const html = await (await handlePanel(new Request('https://panel.example/'))).text();
  assert.ok(html.includes(version));
});

test('面板对照当前、旧版、无版本内核，并提供真实更新说明与下载', async () => {
  for (const coreVersion of [version, '2026.10.13.1', undefined]) {
    const fixture = { uuid, kvEnabled: true, yx: '104.16.1.1:443', ...(coreVersion ? { coreVersion } : {}) };
    // 假 Worker 按路径分流：③ 的会话/令牌接口回固定成功值，其余回配置夹具。
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/api/auth/me')) { res.end(JSON.stringify({ success: true, authenticated: true, passwordSet: true })); return; }
      if (req.url.endsWith('/api/auth/sub-token')) { res.end(JSON.stringify({ success: true, token: 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })); return; }
      res.end(JSON.stringify(fixture));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const host = 'http://127.0.0.1:' + server.address().port;
    try {
      const response = await handlePanel(new Request('https://panel.example/panel?' + new URLSearchParams({ host, uuid })));
      assert.equal(response.status, 200);
      const html = await response.text();
      for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
      const context = JSON.parse(html.match(/window\.CFNEW=(.*?);window\.CFNEW\.subUrl/)[1]);
      assert.equal(context.release.panelVersion, version);
      assert.equal(context.release.coreVersion, coreVersion || '');
      assert.equal(context.release.needsUpdate, coreVersion !== version);
      assert.equal(context.release.changes.length, 2);
      assert.ok(context.release.changes.some(text => text.includes('CPU')));
      assert.ok(context.release.changes.some(text => text.includes('配套内核')));
      assert.equal(context.release.zipUrl, 'https://raw.githubusercontent.com/byJoey/cfnew/core-only/pages.zip');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
