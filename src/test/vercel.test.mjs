process.env.CFNEW_ALLOW_PRIVATE = 'yes';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
// privateTesting 在 server.mjs 模块级读取，须用动态 import 保证 env 赋值在先。
const { handleVercelRequest } = await import('../api/index.mjs');

test('Vercel入口返回完整登录页与禁止缓存头，HEAD没有正文', async () => {
  const request = method => new Request('https://panel.example/', { method });
  const response = await handleVercelRequest(request('GET'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /连接你的 Worker/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await (await handleVercelRequest(request('HEAD'))).text(), '');
});

test('Vercel入口按实际流式字节限制请求体，不信任Content-Length', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1048576));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const response = await handleVercelRequest(new Request('https://panel.example/api/preferred/list', { method: 'POST', headers: { 'Content-Length': '1' }, body, duplex: 'half' }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).success, false);
});

test('Vercel入口登录时透传会话 cookie，正文不含会话令牌', async () => {
  // Phase 1 ③：登录成功时会话令牌只进 HttpOnly cookie，Vercel 适配层须原样保留 Set-Cookie。
  const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
  const token = 'test-session-token-0123456789abcdef';
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/' + uuid + '/api/auth/login') {
      res.end(JSON.stringify({ success: true, sessionToken: token }));
      return;
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not Found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.w;
  process.env.w = 'http://127.0.0.1:' + server.address().port;
  try {
    const response = await handleVercelRequest(new Request('https://panel.example/' + uuid + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-123456' }) }));
    assert.equal(response.status, 200);
    const setCookie = (response.headers.getSetCookie?.() || [])[0] || response.headers.get('set-cookie');
    assert.ok(setCookie, '登录响应须带 Set-Cookie');
    assert.ok(setCookie.includes('cfnew_session=' + token), 'cookie 值须为会话令牌');
    assert.ok(setCookie.includes('HttpOnly'), 'cookie 须 HttpOnly');
    assert.ok(setCookie.includes('Path=/'), 'cookie 须 Path=/');
    assert.ok(setCookie.includes('Max-Age=43200'), 'cookie 须 Max-Age=43200（12 小时）');
    const body = await response.text();
    assert.ok(!body.includes(token), '登录响应正文不得含会话令牌');
    assert.ok(!body.includes('sessionToken'), '登录响应正文不得含 sessionToken 字段');
  } finally {
    if (previous === undefined) delete process.env.w; else process.env.w = previous;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('Vercel入口保留健康检查和404，不把运行文件当静态资源暴露', async () => {
  assert.deepEqual(await (await handleVercelRequest(new Request('https://panel.example/health'))).json(), { ok: true });
  for (const path of ['/server.mjs', '/api/index.mjs', '/package.json', '/.env']) {
    assert.equal((await handleVercelRequest(new Request('https://panel.example' + path))).status, 404, path);
  }
});
