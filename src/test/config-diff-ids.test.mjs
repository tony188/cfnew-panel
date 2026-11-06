import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubscriptionEngine } from '../engine.mjs';

// 测试 UUID（仅本地测试用，现有测试同款夹具 UUID，不含任何真实 UUID）。
const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const fixture = { yx: '104.16.1.1:443#测试', epi: 'yes', epd: 'yes', egi: 'yes', ena: 'yes', ev: 'yes', et: 'no', ex: 'no', ech: 'yes', kvEnabled: true };

// 渲染管理页：id 真值以渲染出的 HTML 为准，不写死表单结构。
const engine = createSubscriptionEngine(fixture, uuid);
const html = await (await engine.render(new Request('https://worker.example/' + uuid))).text();
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function 计算配置差异'));
assert.ok(script, '渲染出的管理页应包含计算配置差异');
const renderedIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

// 从渲染出的脚本里取出元素对应表（键 → 表单元素 id）。
const tableSrc = script.match(/元素对应表\s*=\s*\{([^}]*)\}/);
assert.ok(tableSrc, '渲染出的脚本里应有元素对应表');
const table = new Map([...tableSrc[1].matchAll(/(\w+):\s*'([^']+)'/g)].map(m => [m[1], m[2]]));

// 2026-11-06 线上实测 bug 曾错映射的 10 个键：9 个开关 + s。
// 旧值是 ev→evEnable、et→etEnable、ex→exEnable、ech→echEnable、ena→enaEnable、
// jk→jkEnable、epd→epdEnable、epi→epiEnable、egi→egiEnable、s→s（表单上都不存在）。
const fixedMappings = { ena: 'ena', jk: 'jk', epd: 'epd', epi: 'epi', egi: 'egi', ev: 'ev', et: 'et', ex: 'ex', ech: 'ech', s: 'socksConfig' };

test('元素对应表里的全部 id 在渲染出的管理页里存在', () => {
  assert.equal(table.size, 32, '对应表应有 32 个键，实际 ' + table.size);
  for (const [key, id] of Object.entries(fixedMappings)) {
    assert.equal(table.get(key), id, key + ' 应映射到真实 id ' + id + '，实际 ' + table.get(key));
  }
  const missing = [...table].filter(([, id]) => !renderedIds.has(id));
  assert.deepEqual(missing, [], '对应表里有表单上不存在的 id：' + JSON.stringify(missing));
});

function extractFunction(name) {
  const found = script.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  assert.ok(found, '渲染出的脚本里找不到函数 ' + name);
  return found[0];
}

// 计算配置差异只用 document.getElementById 判元素存在，不读 DOM 值；
// 存根按渲染出的真实 id 集返回元素，不存在的 id 返回 null（与浏览器一致）。
const stubDocument = { getElementById: (id) => (renderedIds.has(id) ? {} : null) };
function makeCalcDiff(loaded) {
  return new Function('document', '上次加载配置', extractFunction('计算配置差异') + '; return 计算配置差异;')(stubDocument, loaded);
}

test('取消 ech 勾选能产生含 ech 的差异（线上 bug 回归）', () => {
  const loaded = { ...fixture, ech: 'yes' };
  const next = { ...loaded, ech: 'no' };
  const diff = makeCalcDiff(loaded)(next, 'yes', false);
  const ech = diff.find(d => d.key === 'ech');
  assert.ok(ech, '取消 ech 勾选应产生差异，实际差异键：' + JSON.stringify(diff.map(d => d.key)));
  assert.equal(ech.旧值, 'yes');
  assert.equal(ech.新值, 'no');
});

test('开关类改动都能产生差异：ev/et/ex/ena/jk/epd/epi/egi/s', () => {
  const loaded = { ...fixture, ev: 'yes', et: 'no', ex: 'no', ena: 'yes', jk: 'no', epd: 'yes', epi: 'yes', egi: 'yes', s: '' };
  const next = { ...loaded, ev: 'no', et: 'yes', ex: 'yes', ena: 'no', jk: 'yes', epd: 'no', epi: 'no', egi: 'no', s: 'http://proxy.example:8080' };
  const diff = makeCalcDiff(loaded)(next, 'yes', false);
  const keys = diff.map(d => d.key);
  for (const key of ['ev', 'et', 'ex', 'ena', 'jk', 'epd', 'epi', 'egi', 's']) {
    assert.ok(keys.includes(key), key + ' 改动后应产生差异，实际差异键：' + JSON.stringify(keys));
  }
});

test('ev 兜底改写标注只在改前三协议全关时出现', () => {
  const loaded = { ev: 'no', et: 'no', ex: 'no', ech: 'no' };
  const next = { ...loaded, ev: 'yes' };
  const allOff = makeCalcDiff(loaded)(next, 'yes', true);
  assert.equal(allOff.find(d => d.key === 'ev').联动, 'ev 兜底改写');
  const oneOn = makeCalcDiff(loaded)(next, 'yes', false);
  assert.equal(oneOn.find(d => d.key === 'ev').联动, '');
});

test('改前协议状态须用读取开关值读复选框（旧写法读不到）', () => {
  const checkbox = { checked: false, value: 'on' };
  const doc = { getElementById: (id) => (id === 'ev' ? checkbox : null) };
  const readField = new Function('document', extractFunction('读取字段值') + '; return 读取字段值;')(doc);
  const readSwitch = new Function('document', extractFunction('读取开关值') + '; return 读取开关值;')(doc);
  assert.equal(readField('evEnable'), '', '不存在的元素读字段值应为空串');
  assert.equal(readField('ev'), 'on', '复选框的 .value 是 on、永远不是 yes，旧写法读不到真实状态');
  assert.equal(readSwitch('ev', true), 'no', '未勾选的复选框应读到 no');
  checkbox.checked = true;
  assert.equal(readSwitch('ev', true), 'yes', '已勾选的复选框应读到 yes');
});
