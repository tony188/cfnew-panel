import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSubscriptionEngine } from '../engine.mjs';

// Phase 1 ⑤ 面板去上游化回归测试。测试 UUID 仅本地测试用，不含任何真实 UUID。
const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const fixture = { yx: '104.16.1.1:443#测试', epi: 'yes', epd: 'yes', egi: 'yes', ena: 'yes', ev: 'yes', et: 'no', ex: 'no', ech: 'yes', kvEnabled: true, coreVersion: '2026.10.17.2', configVersion: 2 };

// 渲染管理页：id 真值以渲染出的 HTML 为准，不写死表单结构。
const engine = createSubscriptionEngine(fixture, uuid);
const html = await (await engine.render(new Request('https://worker.example/' + uuid))).text();
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function 收集界面配置'));
assert.ok(script, '渲染出的管理页应包含收集界面配置');
const renderedIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

// ⑤ 删掉的 9 个键：freeCpu、scu、jk、epi、ipv4、ipv6、ispMobile、ispUnicom、ispTelecom。
const DELETED_KEYS = ['freeCpu', 'scu', 'jk', 'epi', 'ipv4', 'ipv6', 'ispMobile', 'ispUnicom', 'ispTelecom'];

function extractFunction(name) {
  const found = script.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}'));
  assert.ok(found, '渲染出的脚本里找不到函数 ' + name);
  return found[0];
}

test('保存后被删键不复活：收集界面配置不含 freeCpu/scu/jk/epi/ipv4/ipv6/isp*', () => {
  // 存根按渲染出的真实 id 集返回元素，不存在的 id 返回 null（与浏览器一致）。
  // 重点是 epi：旧代码里 epi 默认 yes，删字段后若收集逻辑漏删键，保存会把它写回 yes。
  const stubDocument = {
    getElementById: (id) => (renderedIds.has(id) ? { value: 'yes', checked: true } : null),
  };
  const helpers = ['读取字段值', '读取开关值', '写入字段值', '写入开关值', '是否开关启用']
    .map(extractFunction).join('\n');
  const collect = new Function('document', helpers + '\n' + extractFunction('收集界面配置') + '; return 收集界面配置;')(stubDocument);
  const collected = collect();
  for (const key of DELETED_KEYS) {
    assert.ok(!Object.hasOwn(collected, key), '收集结果不应含被删键 ' + key + '，实际键：' + JSON.stringify(Object.keys(collected)));
  }
  for (const key of ['ech', 'ev', 'et', 'ex', 'ena', 'epd', 'egi', 'd', 'tp', 'p', 'yx', 's']) {
    assert.ok(Object.hasOwn(collected, key), '收集结果应含保留键 ' + key);
  }
});

test('元素对应表不含被删键（32→23）', () => {
  const tableSrc = script.match(/元素对应表\s*=\s*\{([^}]*)\}/);
  assert.ok(tableSrc, '渲染出的脚本里应有元素对应表');
  const keys = [...tableSrc[1].matchAll(/(\w+):\s*'/g)].map(m => m[1]);
  assert.equal(keys.length, 23, '对应表应有 23 个键，实际 ' + keys.length);
  for (const key of DELETED_KEYS) {
    assert.ok(!keys.includes(key), '对应表不应含被删键 ' + key);
  }
});

test('重置全部配置不触碰被删键', () => {
  const src = extractFunction('重置全部配置');
  for (const frag of ["freeCpu: ''", "scu: ''", "epi: ''", "ipv4: ''", "ipv6: ''", "ispMobile: ''", "ispUnicom: ''", "ispTelecom: ''"]) {
    assert.ok(!src.includes(frag), '重置源码不应含 ' + frag);
  }
  assert.ok(!src.includes("document.getElementById('freeCpu')"), '重置源码不应再读 freeCpu 元素');
});

test('当前配置摘要不回显 tp/p/s 凭据，yx 只显示条数', () => {
  const summary = new Function(extractFunction('当前配置摘要') + '; return 当前配置摘要;')();
  const out = summary({ tp: 'SECRET-TP-123', p: '1.2.3.4:443', s: 'socks5://user:pass@host:1080', yx: '1.1.1.1:443#a\n2.2.2.2:443#b', configVersion: 2, coreVersion: '2026.10.17.2', kvEnabled: true, uuid: 'x', snapshots: [] });
  assert.ok(!out.includes('SECRET-TP-123'), '摘要不得回显 tp：' + out);
  assert.ok(!out.includes('1.2.3.4:443'), '摘要不得回显 p：' + out);
  assert.ok(!out.includes('socks5://'), '摘要不得回显 s：' + out);
  assert.ok(out.includes('配置版本：v2'), '摘要应含配置版本：' + out);
  assert.ok(out.includes('内核版本：2026.10.17.2'), '摘要应含内核版本：' + out);
  assert.ok(out.includes('字段数：4'), '摘要应含字段数：' + out);
  assert.ok(out.includes('优选 IP 条数：2'), '摘要应含优选 IP 条数：' + out);
});

test('我的节点状态板读实数：原生 -01、订阅条数、ECH 联动', async () => {
  const rows = { nativeNodeStatus: { textContent: '' }, subNodeCount: { textContent: '' }, echLinkStatus: { textContent: '' } };
  const doc = { getElementById: (id) => rows[id] || null };
  const fakeFetch = async () => ({ ok: true, text: async () => Buffer.from('vless://a\nvless://b\n').toString('base64') });
  const win = { CFNEW: { host: 'https://cfnew.twhok.eu.org', subUrl: 'https://panel.example/sub/test-token' } };
  const update = new Function('document', 'window', 'fetch', extractFunction('更新我的节点状态板') + '; return 更新我的节点状态板;')(doc, win, fakeFetch);
  await update({ ena: 'yes', ech: 'yes' });
  assert.ok(rows.nativeNodeStatus.textContent.includes('优选域名-01'), rows.nativeNodeStatus.textContent);
  assert.ok(rows.nativeNodeStatus.textContent.includes('cfnew.twhok.eu.org:443'), rows.nativeNodeStatus.textContent);
  assert.equal(rows.subNodeCount.textContent, '订阅节点：2 条');
  assert.ok(rows.echLinkStatus.textContent.includes('仅 TLS 节点'), rows.echLinkStatus.textContent);
  // ech 未开 + 订阅地址失效时不报错，给出占位文案
  const rows2 = { nativeNodeStatus: { textContent: '' }, subNodeCount: { textContent: '' }, echLinkStatus: { textContent: '' } };
  const doc2 = { getElementById: (id) => rows2[id] || null };
  const update2 = new Function('document', 'window', 'fetch', extractFunction('更新我的节点状态板') + '; return 更新我的节点状态板;')(doc2, { CFNEW: { host: 'https://cfnew.twhok.eu.org', subUrl: '' } }, fakeFetch);
  await update2({ ena: 'no', ech: 'no' });
  assert.ok(rows2.nativeNodeStatus.textContent.includes('未启用'), rows2.nativeNodeStatus.textContent);
  assert.ok(rows2.echLinkStatus.textContent.includes('未开启'), rows2.echLinkStatus.textContent);
  assert.ok(rows2.subNodeCount.textContent.includes('订阅地址已失效'), rows2.subNodeCount.textContent);
});

test('渲染出的管理页是去上游化后的版面：10 客户端、CLASH 第一、SING-BOX 第二，无 jk 与被删字段', () => {
  const grid = html.match(/<div class="client-grid">([\s\S]*?)<\/div>/);
  assert.ok(grid, '应有客户端矩阵');
  const labels = [...grid[1].matchAll(/>([^<]+)<\/button>/g)].map(m => m[1]);
  assert.deepEqual(labels, ['CLASH', 'SING-BOX', 'STASH', 'SURGE', 'LOON', 'QUANTUMULT X', 'V2RAY', 'V2RAYNG', 'NEKORAY', 'Shadowrocket']);
  for (const id of ['jkClientBtn', 'jk', 'freeCpu', 'scu', 'epi', 'ipv4Enabled', 'latencyTestInput']) {
    assert.ok(!html.includes(`id="${id}"`), '渲染出的 HTML 不应有 id=' + id);
  }
  assert.ok(!html.includes('家宽'), '渲染出的 HTML 不应有家宽入口');
  for (const id of ['copyClashSubBtn', 'copySingboxSubBtn', 'nativeNodeStatus', 'subNodeCount', 'echLinkStatus']) {
    assert.ok(renderedIds.has(id), '应有 ' + id);
  }
  assert.ok(html.includes('<title>CFnew</title>'), '标题应为 CFnew');
  assert.ok(html.includes('我的节点 · 订阅中心'), '副标题应为“我的节点 · 订阅中心”');
  assert.ok(html.includes('复制 OpenClash 订阅'), '应有复制 OpenClash 订阅按钮');
  assert.ok(html.includes('FX: OFF'), '特效默认应为 OFF');
  assert.ok(!html.includes('byJoey') && !html.includes('joeyblog') && !html.includes('NIGHTCITY'), '渲染出的 HTML 不应含上游标识');
  assert.ok(!html.includes('languageSelector'), '渲染出的 HTML 不应有语言选择器');
  assert.ok(!html.includes('10/10'), '系统状态不得再写死 10/10 可用');
  assert.ok(html.includes('未实测'), 'ProxyIP 状态应标注未实测');
});

test('主题与更新说明去上游化：Iris 强调色、无 NIGHTCITY、无 byJoey', async () => {
  const theme = await readFile(new URL('../theme.css', import.meta.url), 'utf8');
  assert.ok(theme.includes('#5646D6'), '主题应含 Iris #5646D6');
  assert.ok(!theme.includes('NIGHTCITY') && !theme.includes('STATUS // ONLINE'), '主题不应含 NIGHTCITY/STATUS 标记');
  assert.ok(theme.includes('.cp-fold') && theme.includes('.cp-save-hint'), '主题应有折叠与保存提示样式');
  const releaseSrc = await readFile(new URL('../release.mjs', import.meta.url), 'utf8');
  assert.ok(releaseSrc.includes('tony188/cfnew-panel/main/worker/_worker.js'), '内核下载应指自有仓');
  assert.ok(releaseSrc.includes('github.com/tony188/cfnew-panel/tree/main/worker'), '仓库链接应指自有仓');
  assert.ok(!releaseSrc.includes('zipUrl') && !releaseSrc.includes('byJoey'), '更新说明不得再有 zipUrl 或 byJoey');
  const bridgeSrc = await readFile(new URL('../bridge.js', import.meta.url), 'utf8');
  assert.ok(bridgeSrc.includes('repoUrl') && bridgeSrc.includes('workerUrl'), '下载区应渲染 workerUrl 与 repoUrl');
  assert.ok(!bridgeSrc.includes('zipUrl'), '下载区不得再有 zipUrl');
});

test('jk 键保留：jk=yes 时 target=vg 生成仍可用（服务端订阅生成不动）', async () => {
  // vpngate 清单用桩 fetch，不走真实网络；一行最小合法节点即可。
  const ovpn = [
    'client', 'dev tun', 'proto tcp', 'remote 1.2.3.4 1194', 'cipher AES-128-CBC', 'auth SHA1',
    '<ca>', '-----BEGIN CERTIFICATE-----', 'FAKECA', '-----END CERTIFICATE-----', '</ca>',
    '<cert>', '-----BEGIN CERTIFICATE-----', 'FAKECERT', '-----END CERTIFICATE-----', '</cert>',
    '<key>', '-----BEGIN PRIVATE KEY-----', 'FAKEKEY', '-----END PRIVATE KEY-----', '</key>',
  ].join('\n');
  const csv = '*vpn,1.2.3.4\n' + ['testhost1', '1.2.3.4', '100', '10', '500000', 'Japan', 'JP', '1', '10 days', '1', '1', '0', 'Test', 'msg', Buffer.from(ovpn).toString('base64')].join(',');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => csv });
  try {
    const eng = createSubscriptionEngine({ ...fixture, jk: 'yes', yx: '104.16.1.1:443#测试' }, uuid);
    const res = await eng.subscribe(new Request('https://worker.example/sub?target=vg'));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('家宽'), 'vg 订阅应含家宽组');
  } finally {
    globalThis.fetch = realFetch;
  }
});
