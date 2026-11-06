// Phase 1 ③ 测试助手：设密码/登录/取订阅令牌、本地假 Worker 的请求头转发。
// 只供测试用，不含任何真实 UUID；TEST_UUID 与 TEST_PASSWORD 均为本地测试值。
import assert from 'node:assert/strict';

export const TEST_UUID = '351c9981-04b6-4103-aa4b-864aa9c91469';
export const TEST_PASSWORD = 'test-password-123456';

// 经面板设密码并登录，返回会话 cookie（`cfnew_session=...`）。
// call(path, init) => Response；path 为 API 相对路径（如 '/api/auth/setup'），
// 调用方须把 access（uuid 或自定义路径） baked 进 call。
export async function loginCookie(call, password = TEST_PASSWORD) {
  const setup = await call('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (![200, 409].includes(setup.status)) assert.fail('setup 应成功或报已设：' + setup.status + ' ' + await setup.text());
  const login = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (login.status !== 200) assert.fail('登录应成功：' + login.status + ' ' + await login.text());
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('cfnew_session='), '登录响应须种会话 cookie');
  return setCookie.split(';')[0];
}

// 经面板取当前订阅令牌（须会话 cookie）。
export async function fetchSubToken(call, cookie) {
  const res = await call('/api/auth/sub-token', { headers: { Cookie: cookie } });
  if (res.status !== 200) assert.fail('取订阅令牌应成功：' + res.status + ' ' + await res.text());
  const json = await res.json();
  assert.ok(json.success && typeof json.token === 'string' && json.token.length >= 32, '应返回订阅令牌');
  return json.token;
}

// 直调 Worker 设密码并登录，返回会话令牌（供 core 直测用）。
// workerFetch(path, init) => Response；path 形如 '/<uuid>/api/auth/setup'。
export async function loginWorkerSession(workerFetch, uuid, password = TEST_PASSWORD) {
  const setup = await workerFetch('/' + uuid + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (![200, 409].includes(setup.status)) assert.fail('setup 应成功或报已设：' + setup.status + ' ' + await setup.text());
  const login = await workerFetch('/' + uuid + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (login.status !== 200) assert.fail('登录应成功：' + login.status + ' ' + await login.text());
  const json = await login.json();
  assert.ok(json.success && typeof json.sessionToken === 'string' && json.sessionToken.length >= 32, '登录应返回会话令牌');
  return json.sessionToken;
}

export function sessionHeaders(token) {
  return { 'X-CFNEW-SESSION': token };
}

// 本地假 Worker 服务：把面板发来的请求头（会话头、Content-Type 等）原样转给 Worker，
// 否则会话头到不了 Worker，面板代理的鉴权测试全是假阴性。
export function forwardHeaders(incoming) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming.headers || {})) {
    if (['host', 'connection', 'content-length'].includes(key)) continue;
    headers[key] = value;
  }
  return headers;
}
