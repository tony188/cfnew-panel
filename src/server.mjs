import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createSubscriptionEngine, renderLoginPage } from './engine.mjs';
import { isPublicAddress, fetchPreferredList, probePreferred } from './preferred.mjs';
import { PANEL_VERSION, coreRelease } from './release.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const privateTesting = process.env.CFNEW_ALLOW_PRIVATE === 'yes';
const theme = '<style>' + await readFile(new URL('./theme.css', import.meta.url), 'utf8') + '</style>';
const landing = (await readFile(new URL('./index.html', import.meta.url), 'utf8')).replace('__CFNEW_PANEL_VERSION__', PANEL_VERSION).replace('</head>', theme + '</head>');
const bridge = await readFile(new URL('./bridge.js', import.meta.url), 'utf8');
const rulesLicense = await readFile(new URL('./singbox-rules.NOTICE.md', import.meta.url), 'utf8') + '\n' + await readFile(new URL('./singbox-rules.LICENSE', import.meta.url), 'utf8');
const safeJson = value => JSON.stringify(value).replaceAll('<', '\\u003c');
// Phase 1 ③：管理会话 cookie（HttpOnly，闲置 30 分钟、绝对 12 小时由 Worker 侧执行）。
const sessionCookieName = 'cfnew_session';
const sessionMaxAgeSeconds = 12 * 60 * 60;
const sessionHeaderName = 'X-CFNEW-SESSION';
const authSuffixes = ['/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/change-password', '/api/auth/rotate-sub-token', '/api/auth/revoke-sub-token', '/api/auth/sub-token'];
const adminSuffixes = ['/api/config', '/api/config/rollback', '/api/config/snapshots', '/api/preferred-ips', '/region', '/test-api'];

function sessionTokenFrom(request) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === sessionCookieName) return rest.join('=').trim();
  }
  return '';
}

function sessionCookieSecure(request) {
  try { if (new URL(request.url).protocol === 'https:') return true; } catch {}
  return (request.headers.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
}

function buildSessionCookie(request, token) {
  return sessionCookieName + '=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + sessionMaxAgeSeconds + (sessionCookieSecure(request) ? '; Secure' : '');
}

function clearSessionCookie(request) {
  return sessionCookieName + '=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' + (sessionCookieSecure(request) ? '; Secure' : '');
}

// Phase 1 ③：会话状态查询（Worker /api/auth/me）。返回 {authenticated, passwordSet, ...}。
async function checkSession(workerBase, access, sessionToken = '') {
  workerBase = selectWorker(workerBase);
  const uuid = normalizeAccess(access);
  const response = await requestWorkerApi(workerBase, uuid, '/api/auth/me', 'GET', undefined, sessionToken);
  let value;
  try { value = JSON.parse(response.body); } catch { value = null; }
  if (response.status === 404) {
    // 旧内核没有 /api/auth/me：再读一次配置区分“旧内核”与“错误入口”。
    // 旧内核的配置接口无鉴权且不带 uuid；新内核的配置接口须会话（401）或入口错误（404）。
    const probe = await requestWorkerApi(workerBase, uuid, '/api/config', 'GET');
    if (probe.status === 200) {
      let probeConfig = null;
      try { probeConfig = JSON.parse(probe.body); } catch {}
      if (probeConfig && typeof probeConfig.uuid !== 'string') throw Object.assign(new Error('请更新精简内核后再使用自定义路径登录'), { status: 400 });
    }
    throw Object.assign(new Error('读取配置失败，请确认 Worker 域名、UUID 或自定义路径和核心版本'), { status: 400, upstreamStatus: 404 });
  }
  if (response.status !== 200 || !value || typeof value !== 'object') throw Object.assign(new Error('读取会话状态失败'), { status: response.status >= 400 ? response.status : 502, upstreamStatus: response.status });
  return value;
}

// 取当前订阅令牌（会话）。无令牌（已撤销）时返回 null。
async function loadSubToken(workerBase, access, sessionToken) {
  workerBase = selectWorker(workerBase);
  const uuid = normalizeAccess(access);
  const response = await requestWorkerApi(workerBase, uuid, '/api/auth/sub-token', 'GET', undefined, sessionToken);
  let value;
  try { value = JSON.parse(response.body); } catch { value = null; }
  if (response.status !== 200 || !value || typeof value !== 'object') return null;
  return typeof value.token === 'string' && value.token ? value.token : null;
}

// 凭订阅令牌取订阅生成用配置（Worker /api/auth/sub-config，不带 UUID 前缀）。
async function loadSubConfig(workerBase, token) {
  workerBase = selectWorker(workerBase);
  const response = await requestWorkerUrl(workerBase, new URL(workerBase + '/api/auth/sub-config'), 'POST', JSON.stringify({ token }));
  if (response.status === 401) throw Object.assign(new Error('订阅令牌无效'), { status: 401 });
  if (response.status !== 200) throw Object.assign(new Error('订阅更新失败'), { status: response.status });
  const config = JSON.parse(response.body);
  if (!config || Array.isArray(config) || typeof config !== 'object' || typeof config.kvEnabled !== 'boolean') throw new Error('该地址没有兼容的配置接口');
  const resolvedUuid = typeof config.uuid === 'string' ? config.uuid.toLowerCase() : '';
  if (!uuidPattern.test(resolvedUuid)) throw new Error('订阅令牌无效');
  return { ...config, uuid: resolvedUuid };
}

async function authorizePreferred(workerBase, access, sessionToken = '') {
  workerBase = selectWorker(workerBase);
  const me = await checkSession(workerBase, access, sessionToken);
  if (!me.authenticated) throw Object.assign(new Error('管理会话已过期或无效，请重新登录'), { status: 401 });
}

export function normalizeWorker(value) {
  const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入 Worker 域名');
  if (!privateTesting && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) throw new Error('Worker 须使用 HTTPS');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('域名中不要带路径');
  return url.origin;
}

function allowedWorker() {
  const value = String(process.env.w || '').trim();
  if (!value) return '';
  try { return normalizeWorker(value); }
  catch { throw Object.assign(new Error('面板 w 配置无效，请填写 Worker 的 HTTPS 根地址'), { status: 503 }); }
}

function selectWorker(value) {
  const allowed = allowedWorker();
  const workerBase = normalizeWorker(String(value || allowed).trim());
  if (allowed && workerBase !== allowed) throw Object.assign(new Error('此面板仅允许接入指定的 Worker'), { status: 403 });
  return workerBase;
}

export function normalizeAccess(value) {
  const access = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!access || access.length > 2048 || /[?#\\\u0000-\u0020\u007f]/.test(access)) throw new Error('请填写 UUID 或自定义路径');
  let decoded;
  try { decoded = decodeURIComponent(access); } catch { throw new Error('自定义路径格式无效'); }
  if (/[?#\\\u0000-\u0020\u007f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) throw new Error('自定义路径格式无效');
  return uuidPattern.test(access) ? access.toLowerCase() : new URL('/' + access, 'https://path.invalid').pathname.slice(1);
}

const workerAddresses = new Map();
const recentConfig = new Map();

async function requestWorkerUrl(workerBase, url, method = 'GET', body = undefined, extraHeaders = {}) {
  workerBase = selectWorker(workerBase);
  let address = workerAddresses.get(workerBase);
  if (!address || address.expires < Date.now()) {
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!addresses.length || (!privateTesting && addresses.some(item => !isPublicAddress(item.address)))) throw new Error('Worker 域名必须解析到公网地址');
    address = { ...addresses[0], expires: Date.now() + 60000 };
    if (workerAddresses.size >= 128) workerAddresses.delete(workerAddresses.keys().next().value);
    workerAddresses.set(workerBase, address);
  }
  return new Promise((resolve, reject) => {
    const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; CFnewPanel)', ...extraHeaders, ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2097152) { outgoing.destroy(new Error('配置响应过大')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    const timer = setTimeout(() => outgoing.destroy(new Error('连接 Worker 超时')), 10000);
    outgoing.on('close', () => clearTimeout(timer)); outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function requestWorkerApi(workerBase, uuid, suffix, method = 'GET', body = undefined, sessionToken = '') {
  workerBase = selectWorker(workerBase);
  const url = new URL(workerBase + '/' + uuid + suffix);
  return requestWorkerUrl(workerBase, url, method, body, sessionToken ? { [sessionHeaderName]: sessionToken } : {});
}

export async function loadWorkerConfig(workerBase, access, sessionToken = '') {
  workerBase = selectWorker(workerBase);
  const uuid = normalizeAccess(access);
  // 不在此处以“无令牌”直接拒：调用方已先验会话，且 Worker 侧读配置无有效会话会回 401，
  // 此处按 Worker 返回状态映射（401 即会话无效）。面板侧多判一道会误杀已验会话的调用方。
  const key = workerBase + '/' + uuid;
  const recent = recentConfig.get(key);
  if (recent && recent.expires > Date.now()) {
    // 缓存命中时仍须先验会话，否则注销/改密码后 70 秒内仍能读到缓存配置。
    const me = await requestWorkerApi(workerBase, uuid, '/api/auth/me', 'GET', undefined, sessionToken);
    let meJson;
    try { meJson = JSON.parse(me.body); } catch { meJson = null; }
    if (me.status !== 200 || !meJson || meJson.authenticated !== true) throw Object.assign(new Error('管理会话已过期或无效，请重新登录'), { status: 401 });
    return recent.config;
  }
  recentConfig.delete(key);
  const response = await requestWorkerApi(workerBase, uuid, '/api/config', 'GET', undefined, sessionToken);
  if (response.status === 401) throw Object.assign(new Error('管理会话已过期或无效，请重新登录'), { status: 401 });
  if (response.status !== 200) throw Object.assign(new Error('读取配置失败，请确认 Worker 域名、UUID 或自定义路径和核心版本'), { upstreamStatus: response.status });
  const config = JSON.parse(response.body);
  if (!config || Array.isArray(config) || typeof config !== 'object' || typeof config.kvEnabled !== 'boolean') throw new Error('该地址没有兼容的配置接口');
  const resolvedUuid = typeof config.uuid === 'string' ? config.uuid.toLowerCase() : uuidPattern.test(uuid) ? uuid : '';
  if (!uuidPattern.test(resolvedUuid)) throw new Error('请更新精简内核后再使用自定义路径登录');
  return { ...config, uuid: resolvedUuid };
}

function targetForAgent(agent = '') {
  const ua = (agent || '').toLowerCase();
  if (ua.includes('sing-box') || ua.includes('singbox')) return 'singbox';
  if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('stash')) return 'clash';
  if (ua.includes('surge')) return 'surge';
  if (ua.includes('loon')) return 'loon';
  if (ua.includes('quantumult')) return 'quanx';
  return 'base64';
}

async function handleWorkerApi(request, workerBase, access, suffix) {
  try {
    workerBase = selectWorker(workerBase);
    access = normalizeAccess(access);
    if (![...authSuffixes, ...adminSuffixes].includes(suffix) || !['GET', 'POST', 'DELETE'].includes(request.method)) throw new Error('接口不支持');
    const sessionToken = sessionTokenFrom(request);
    const isAuth = authSuffixes.includes(suffix);
    if (suffix === '/api/config' && request.method === 'GET') return Response.json(await loadWorkerConfig(workerBase, access, sessionToken));
    // 认证类接口直接用 access（UUID 或自定义路径）调 Worker，Worker 侧按前缀匹配；
    // 管理类接口先解析出真实 UUID（会话内调 loadWorkerConfig）。
    const uuid = isAuth || uuidPattern.test(access) ? access : (await loadWorkerConfig(workerBase, access, sessionToken)).uuid;
    const result = await requestWorkerApi(workerBase, uuid, suffix, request.method, request.method === 'GET' ? undefined : await request.text(), sessionToken);
    let value;
    try { value = JSON.parse(result.body); } catch {}
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return Response.json({ success: false, message: result.status === 413 ? '配置过大，请减少优选条目或改用列表 URL' : 'Worker 返回无效响应（HTTP ' + result.status + '），请稍后重试' }, { status: result.status >= 400 ? result.status : 502 });
    }
    if (result.status === 200 && request.method !== 'GET' && !isAuth) {
      const key = workerBase + '/' + uuid;
      if (value.success && value.config) {
        if (recentConfig.size >= 128) recentConfig.delete(recentConfig.keys().next().value);
        // 以 Worker 已成功持久化后的有效快照消除 KV 跨边缘的短暂旧值。
        recentConfig.set(key, { expires: Date.now() + 70000, config: { ...value.config, uuid, kvEnabled: true, ...(typeof value.configVersion === 'number' ? { configVersion: value.configVersion } : {}), ...(Array.isArray(value.snapshots) ? { snapshots: value.snapshots } : {}) } });
      } else if (value.success) recentConfig.delete(key);
    }
    // 登录成功：会话令牌绝不进响应正文，只以 HttpOnly cookie 种下；退出/改密码：清掉 cookie。
    const headers = { 'Content-Type': 'application/json' };
    let body = result.body;
    if (suffix === '/api/auth/login' && result.status === 200 && value.success && typeof value.sessionToken === 'string' && value.sessionToken) {
      const { sessionToken: _dropped, ...rest } = value;
      body = JSON.stringify(rest);
      headers['Set-Cookie'] = buildSessionCookie(request, value.sessionToken);
    } else if ((suffix === '/api/auth/logout' || suffix === '/api/auth/change-password') && result.status === 200 && value.success) {
      headers['Set-Cookie'] = clearSessionCookie(request);
    }
    return new Response(body, { status: result.status, headers });
  } catch (error) { return Response.json({ success: false, message: error.message }, { status: error.status || 400 }); }
}

export async function handlePanel(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/worker-api/')) {
    const match = url.pathname.match(/^\/worker-api\/([^/]+)\/(.+?)(\/api\/.*|\/region|\/test-api)$/);
    if (!match) return Response.json({ success: false, message: '接口地址无效' }, { status: 400 });
    return handleWorkerApi(request, Buffer.from(match[1], 'base64url').toString('utf8'), match[2], match[3]);
  }
  let boundWorker;
  try { boundWorker = allowedWorker(); }
  catch (error) { return new Response(error.message, { status: error.status || 503 }); }
  if (boundWorker) {
    const match = url.pathname.match(/^\/(.+)(\/api\/config\/rollback|\/api\/config\/snapshots|\/api\/config|\/api\/preferred-ips|\/region|\/test-api|\/api\/auth\/setup|\/api\/auth\/login|\/api\/auth\/logout|\/api\/auth\/me|\/api\/auth\/change-password|\/api\/auth\/rotate-sub-token|\/api\/auth\/revoke-sub-token|\/api\/auth\/sub-token)\/?$/);
    if (match) return handleWorkerApi(request, boundWorker, match[1], match[2]);
  }
  if (['/api/preferred/probe', '/api/preferred/list'].includes(url.pathname)) {
    if (request.method !== 'POST') return Response.json({ message: '只支持 POST' }, { status: 405 });
    try {
      const data = await request.json();
      const workerBase = selectWorker(data.host);
      const uuid = normalizeAccess(data.uuid);
      await authorizePreferred(workerBase, uuid, sessionTokenFrom(request));
      if (url.pathname.endsWith('/list')) return new Response(await fetchPreferredList(data.url, request.signal), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return Response.json(await probePreferred(workerBase, data.address, data.port, request.signal));
    } catch (error) {
      return Response.json({ success: false, message: error.message, latency: -1 }, { status: error.status || 400 });
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('只支持 GET', { status: 405 });
  // Phase 1 ③：订阅只认订阅令牌。新形态 /sub/<token>；旧的 /<UUID>/sub 与 /sub?uuid= 一律拒绝。
  const subTokenMatch = url.pathname.match(/^\/sub\/([A-Za-z0-9_-]{32,64})\/?$/);
  if (subTokenMatch) {
    try {
      const workerBase = selectWorker(url.searchParams.get('host'));
      const config = await loadSubConfig(workerBase, subTokenMatch[1]);
      const uuid = config.uuid;
      const engine = createSubscriptionEngine(config, uuid);
      const workerUrl = new URL(workerBase + '/' + uuid + '/sub');
      workerUrl.searchParams.set('target', url.searchParams.get('target') || targetForAgent(request.headers.get('User-Agent')));
      return await engine.subscribe(new Request(workerUrl, { headers: request.headers }));
    } catch (error) {
      return new Response('订阅更新失败：' + error.message, { status: error.status || 503 });
    }
  }
  if (url.pathname === '/sub') {
    // 绑定模式下带外来 host/uuid 参数的旧形态订阅仍按旧行为返回 403（跨 Worker 拒绝）。
    if (boundWorker && (url.searchParams.has('host') || url.searchParams.has('uuid'))) return new Response('已绑定指定 Worker，不接受其它 Worker 的订阅请求', { status: 403 });
    return new Response('Not Found', { status: 404 });
  }
  if (url.pathname === '/health') return Response.json({ ok: true });
  if (url.pathname === '/rules-license') return new Response(rulesLicense, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  if (url.pathname === '/') {
    if (boundWorker) return new Response('hello', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    try { return new Response(landing, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
    catch (error) { return new Response(error.message, { status: error.status || 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  }
  const legacy = url.pathname === '/panel' && (!boundWorker || url.searchParams.has('uuid') || url.searchParams.has('host'));
  const protectedPath = /^\/(?:api|data|public|tools)(?:\/|$)/.test(url.pathname) || url.pathname.startsWith('/.') || /^\/(?:server\.mjs|engine\.mjs|preferred\.mjs|release\.mjs|package(?:-lock)?\.json|index\.html|bridge\.js|theme\.css|favicon\.ico|robots\.txt)$/.test(url.pathname);
  if (!legacy && (!boundWorker || protectedPath)) return new Response('Not Found', { status: 404 });
  const pathname = url.pathname.replace(/\/+$/, '');
  try {
    const workerBase = selectWorker(url.searchParams.get('host'));
    const access = normalizeAccess(legacy ? url.searchParams.get('uuid') : pathname.slice(1));
    const sessionToken = sessionTokenFrom(request);
    const me = await checkSession(workerBase, access, sessionToken);
    const loginApiBase = boundWorker ? '/' + access : '/worker-api/' + Buffer.from(workerBase).toString('base64url') + '/' + access;
    if (!me.authenticated) {
      return new Response(renderLoginPage({ passwordSet: !!me.passwordSet, apiBase: loginApiBase }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const config = await loadWorkerConfig(workerBase, access, sessionToken);
    const uuid = config.uuid;
    const subToken = await loadSubToken(workerBase, access, sessionToken);
    const engine = createSubscriptionEngine(config, uuid);
    const rendered = await engine.render(new Request(workerBase + '/' + uuid, { headers: request.headers }));
    const subPath = subToken ? '/sub/' + subToken : '';
    const context = { host: workerBase, uuid, apiBase: boundWorker ? '/' + uuid : '/worker-api/' + Buffer.from(workerBase).toString('base64url') + '/' + uuid, subPath, ...(boundWorker ? { panelPath: '/' + uuid } : {}), config, release: coreRelease(config) };
    const boot = '<script>window.CFNEW=' + safeJson(context) + ';window.CFNEW.subUrl=location.origin+window.CFNEW.subPath;' + bridge + '</script>';
    let html = await rendered.text();
    html = html.replace('<head>', '<head>' + boot + theme);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (error) {
    if (!legacy && [403, 404].includes(error.upstreamStatus)) return new Response('Not Found', { status: 404 });
    if (error.status === 401) return new Response('管理会话已过期或无效，请刷新页面重新登录', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const message = String(error.message).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接未完成</title>' + theme + '<body class="landing"><main><div class="brand">CFNEW</div><h1>连接未完成</h1><p>' + message + '</p><a href="/">返回重新填写</a></main></body></html>', { status: error.status || 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

export function createPanelServer() {
  return createHttpServer(async (incoming, outgoing) => {
    try {
      const chunks = []; let size = 0;
      if (!['GET', 'HEAD'].includes(incoming.method)) {
        for await (const chunk of incoming) {
          size += chunk.length;
          if (size > 1048576) {
            outgoing.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            outgoing.end(JSON.stringify({ success: false, message: '配置过大，请减少优选条目或改用列表 URL（请求上限 1 MiB）' }));
            return;
          }
          chunks.push(chunk);
        }
      }
      const request = new Request('http://' + (incoming.headers.host || 'localhost') + incoming.url, { method: incoming.method, headers: incoming.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handlePanel(request);
      const headers = Object.fromEntries(response.headers);
      // Set-Cookie 须用 getSetCookie 取，否则多条 cookie 会在 Object.fromEntries 里被合并。
      if (typeof response.headers.getSetCookie === 'function') {
        const cookies = response.headers.getSetCookie();
        if (cookies.length) headers['Set-Cookie'] = cookies;
      }
      Object.assign(headers, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      outgoing.writeHead(response.status, headers);
      if (incoming.method === 'HEAD') { outgoing.end(); return; }
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      outgoing.end(JSON.stringify({ success: false, message: '服务暂时不可用，请稍后重试' }));
    }
  });
}

if (!process.env.VERCEL && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3100);
  const host = process.env.HOST || '127.0.0.1';
  createPanelServer().listen(port, host, () => console.log('CFnew 独立面板已启动，端口 ' + port));
}
