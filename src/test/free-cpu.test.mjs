import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSubscriptionEngine } from '../engine.mjs';
import { loginWorkerSession } from './auth-helpers.mjs';

const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const source = await readFile(process.env.CFNEW_TEST_CORE || new URL('../../test/core-fixture.mjs', import.meta.url), 'utf8');
const stripped = source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, (_, name) => 'const ' + name.trim() + ' = () => { throw new Error("此测试不建立代理连接"); };');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(stripped).toString('base64'))).default;
const request = init => new Request('https://worker.example/' + uuid + '/api/config', init);
function storage(initial = {}) {
  const values = new Map([['c', JSON.stringify(initial)]]);
  return { values, get: async key => JSON.parse(values.get(key) || 'null'), put: async (key, value) => values.set(key, value) };
}

// Phase 1 ③：直调 Worker 管理接口须带会话；会话按 KV 记，故读配置也须有 KV。
async function authedCall(env) {
  const token = await loginWorkerSession((path, init) => worker.fetch(new Request('https://worker.example' + path, init), env), uuid);
  return (init) => worker.fetch(request({ ...init, headers: { ...(init?.headers || {}), 'X-CFNEW-SESSION': token } }), env);
}

test('Free保护默认关闭，环境变量可开启，KV可覆盖且保存后立即读回', async () => {
  const callDefault = await authedCall({ u: uuid, C: storage() });
  assert.equal((await (await callDefault()).json()).freeCpu, 'no');
  const callEnv = await authedCall({ u: uuid, FREE_CPU: 'yes', C: storage() });
  assert.equal((await (await callEnv()).json()).freeCpu, 'yes');
  const C = storage(); const env = { u: uuid, C, freeCpu: 'yes' };
  const call = await authedCall(env);
  for (const value of ['no', 'yes', false, true]) {
    const saved = await call({ method: 'POST', body: JSON.stringify({ freeCpu: value }) });
    assert.equal(saved.status, 200);
    const config = await (await call()).json();
    assert.equal(config.freeCpu, value === 'yes' || value === true ? 'yes' : 'no');
  }
  await call({ method: 'POST', body: '{"freeCpu":""}' });
  assert.equal((await (await call()).json()).freeCpu, 'yes');
  assert.equal(Object.hasOwn(JSON.parse(C.values.get('c')), 'freeCpu'), false);
});

test('不同Worker的保护设置不会串用，开关不改变客户端订阅', async () => {
  const [on, off] = await Promise.all(['yes', 'no'].map(async freeCpu => {
    const call = await authedCall({ u: uuid, C: storage({ freeCpu }) });
    return call().then(r => r.json());
  }));
  assert.equal(on.freeCpu, 'yes'); assert.equal(off.freeCpu, 'no');
  const config = { ev: 'yes', et: 'yes', ex: 'yes', yx: '104.16.1.1:443', epi: 'yes', epd: 'no', egi: 'no' };
  const subscribe = async freeCpu => (await createSubscriptionEngine({ ...config, freeCpu }, uuid).subscribe(new Request('https://worker.example/sub?target=base64'))).text();
  assert.equal(await subscribe('yes'), await subscribe('no'));
});

test('管理页不再提供 Free CPU 开关，但 core 侧 freeCpu 键行为不变，页面脚本有效', async () => {
  for (const config of [{ freeCpu: 'yes' }, {}]) {
    const html = await (await createSubscriptionEngine(config, uuid).render(new Request('https://worker.example/' + uuid))).text();
    assert.ok(!html.includes('id="freeCpu"'), '管理页不应再有 freeCpu 开关');
    assert.ok(!html.includes('freeCpuHint'), '管理页不应再有 freeCpu 说明');
    for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
  }
});
