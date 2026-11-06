import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test('wrangler.toml 模板：服务名/main/绑定正确，KV id 仍是占位符，无真实 UUID、无 vars.u', async () => {
  const toml = await read('worker/wrangler.toml');
  assert.match(toml, /name\s*=\s*"cfnew"/);
  assert.match(toml, /main\s*=\s*"\_worker\.js"/);
  assert.match(toml, /binding\s*=\s*"C"/);
  assert.ok(toml.includes('__CFNEW_KV_ID__'), 'KV id 须是占位符，由部署脚本按名查 KV 后替换');
  assert.ok(!toml.includes('vars.u'), 'u 绝不写进 wrangler.toml，须以 secret 注入');
  assert.ok(!/\bu\s*=/.test(toml), '不得有 u 变量赋值');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(toml), '模板里不得有真实 UUID');
  assert.ok(!/[0-9a-f]{32}/.test(toml.replace('__CFNEW_KV_ID__', '')), '模板里不得有真实 KV id');
});

test('vendor 的 worker/_worker.js 与 test/core-fixture.mjs 逐字节一致', async () => {
  const vendored = await readFile(new URL('worker/_worker.js', root));
  const fixture = await readFile(new URL('test/core-fixture.mjs', root));
  assert.equal(sha256(vendored), sha256(fixture));
});

test('.gitignore 覆盖 .cfnew-state 与 .vercel/（状态文件与 link 文件不入仓）', async () => {
  const ignore = await read('.gitignore');
  assert.ok(ignore.split('\n').some((l) => l.trim() === '.cfnew-state'));
  assert.ok(ignore.split('\n').some((l) => l.trim() === '.vercel/'));
});

test('部署脚本：fail-closed、支持 dry-run、不把密钥写进命令行或日志', async () => {
  const script = await read('scripts/deploy-one-click.sh');
  assert.ok(script.includes('set -euo pipefail'), '任一步失败即停');
  assert.ok(script.includes('--dry-run'), '须支持 --dry-run');
  assert.ok(!/^set -x/m.test(script), '不得开 set -x（会泄露环境变量里的 token）');
  assert.ok(!script.includes('echo $CLOUDFLARE_API_TOKEN') && !script.includes('echo $VERCEL_TOKEN'), '不得回显 token');
  assert.ok(!script.includes('echo $ADMIN_PASSWORD') && !script.includes('echo "$ADMIN_PASSWORD"'), '不得回显管理密码');
  assert.ok(script.includes('secret put u'), 'u 以 secret 注入');
  assert.ok(script.includes('env add w'), 'w 持久化到 Vercel 环境变量');
  assert.ok(script.includes('ssoProtection'), '关 Deployment Protection');
  assert.ok(script.includes('.cfnew-state'), '状态文件机制在');
  assert.ok(script.includes('configVersion'), '验收须读 configVersion（① 复验）');
  assert.ok(script.includes('/sub/'), '输出新形态订阅链接（③ 复验），不用旧 UUID 形态');
  assert.ok(!script.includes('grep -q "workers.dev"'), '不得全文 grep workers.dev：sing-box 内联 geosite 里 workers.dev 是公开域名条目，会误报');
  assert.ok(script.includes('worker_host'), '订阅检查须以 Worker 主机为准绳：节点 workers.dev 只能是 Worker 自己');
});

test('README Deploy 按钮指自有仓、含 env=w，不再指 byJoey', async () => {
  const readme = await read('README.md');
  const match = readme.match(/https:\/\/vercel\.com\/new\/clone\?[^)\s]+/);
  assert.ok(match, 'README 里须有 Deploy 按钮链接');
  const url = match[0];
  assert.ok(url.includes('github.com%2Ftony188%2Fcfnew-panel'), '按钮须指自有仓 tony188/cfnew-panel');
  assert.ok(!url.includes('byJoey'), '按钮不得再指 byJoey 原仓');
  assert.ok(url.includes('env=w'), '按钮链接须含 env=w');
  assert.ok(url.includes('project-name=cfnew-panel') && url.includes('repository-name=cfnew-panel'));
  assert.ok(readme.includes('全新环境备用路'), '按钮旁须写明是全新环境备用路，已部署用户不得点');
});
