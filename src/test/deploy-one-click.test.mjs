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

test('自动探测 CF_ACCOUNT_ID：未提供时调 GET /client/v4/accounts，恰好一个用其 id，0 个或多个报错提示填 ID', async () => {
  const script = await read('scripts/deploy-one-click.sh');
  assert.ok(script.includes('detect_cf_account'), '须有 CF 账号探测函数');
  assert.ok(script.includes('"$CF_API_BASE/accounts"'), '须调 accounts 接口探测');
  assert.ok(script.includes('该 token 下没有 Cloudflare 账号') && script.includes('请填 CF_ACCOUNT_ID'), '0 个账号须报错提示填 CF_ACCOUNT_ID');
  assert.ok(script.includes('个 Cloudflare 账号，无法确定') && script.includes('请填 CF_ACCOUNT_ID'), '多个账号须报错提示填 CF_ACCOUNT_ID');
  assert.ok(script.includes('自动探测到 Cloudflare 账号'), '恰好一个账号时须取用其 id');
  assert.ok(!script.includes('die "缺 CF_ACCOUNT_ID'), 'CF_ACCOUNT_ID 不再是必填 die 项');
});

test('自动探测 Vercel 团队与项目：GET /v2/teams 与 GET /v9/projects，按 name == cfnew-panel 过滤', async () => {
  const script = await read('scripts/deploy-one-click.sh');
  assert.ok(script.includes('detect_vercel_project'), '须有 Vercel 探测函数');
  assert.ok(script.includes('/v2/teams'), '须调 teams 接口探测团队');
  assert.ok(script.includes('/v9/projects'), '须调 projects 接口探测项目');
  assert.ok(script.includes('VERCEL_PROJECT_NAME="cfnew-panel"'), '项目须按 name == cfnew-panel 过滤');
  assert.ok(script.includes('走个人 scope'), '0 个团队走个人 scope（不带 teamId）');
  assert.ok(script.includes('个 Vercel 团队，无法确定') && script.includes('请填 VERCEL_ORG_ID'), '多个团队须报错提示填 VERCEL_ORG_ID');
  assert.ok(script.includes('没有名为') && script.includes('请填 VERCEL_PROJECT_ID'), '0 个同名项目须报错提示填 VERCEL_PROJECT_ID');
  assert.ok(script.includes('个名为') && script.includes('请填 VERCEL_PROJECT_ID'), '多个同名项目须报错提示填 VERCEL_PROJECT_ID');
  assert.ok(script.includes('自动探测到 Vercel 项目'), '恰好一个同名项目时须取用其 id');
});

test('显式 ID 覆盖探测：提供了就直接用，不探测', async () => {
  const script = await read('scripts/deploy-one-click.sh');
  const cfStart = script.indexOf('detect_cf_account()');
  assert.ok(cfStart >= 0);
  assert.ok(script.indexOf('使用提供的 CF_ACCOUNT_ID', cfStart) < script.indexOf('"$CF_API_BASE/accounts"', cfStart), '显式 CF_ACCOUNT_ID 须先于探测调用');
  const vStart = script.indexOf('detect_vercel_project()');
  assert.ok(vStart >= 0);
  assert.ok(script.indexOf('使用提供的 VERCEL_ORG_ID', vStart) < script.indexOf('/v2/teams', vStart), '显式 VERCEL_ORG_ID 须先于团队探测');
  assert.ok(script.indexOf('使用提供的 VERCEL_PROJECT_ID', vStart) < script.indexOf('/v9/projects', vStart), '显式 VERCEL_PROJECT_ID 须先于项目探测');
});

test('.vercel/project.json 已存在时优先用它，不探测', async () => {
  const script = await read('scripts/deploy-one-click.sh');
  const linkStart = script.indexOf('step_vercel_link()');
  assert.ok(linkStart >= 0);
  const pj = script.indexOf('.vercel/project.json', linkStart);
  const det = script.indexOf('detect_vercel_project', linkStart);
  assert.ok(pj >= 0 && det >= 0 && pj < det, 'project.json 分支须在探测调用之前');
  assert.ok(script.includes('（.vercel/project.json），不探测'), 'project.json 分支须说明不探测');
});

test('必填只剩两个真凭证：CLOUDFLARE_API_TOKEN 与 VERCEL_TOKEN；三个 ID 改为自动探测', async () => {
  const script = await read('scripts/deploy-one-click.sh');
  assert.ok(script.includes('必填（只剩两个真凭证）'), '头注释须说明只剩两个必填');
  assert.ok(script.includes('必填环境变量：CLOUDFLARE_API_TOKEN、VERCEL_TOKEN。'), 'usage 须只列两个必填');
  assert.ok(script.includes('自动探测：CF_ACCOUNT_ID'), 'usage 须说明 CF_ACCOUNT_ID 自动探测');
  assert.ok(!script.includes('die "缺 CF_ACCOUNT_ID'), '不得再有 CF_ACCOUNT_ID 必填 die');
  assert.ok(!script.includes('die "缺 VERCEL_ORG_ID'), '不得再有 VERCEL_ORG_ID 必填 die');
  assert.ok(!script.includes('die "缺 VERCEL_PROJECT_ID'), '不得再有 VERCEL_PROJECT_ID 必填 die');
});

test('dry-run 下探测只打印命令、不执行、不写状态', async () => {
  const script = await read('scripts/deploy-one-click.sh');
  assert.ok(script.includes('CF_ACCOUNT_ID="<ACCOUNT_ID>"'), 'dry-run 下 CF 探测须用占位 id');
  assert.ok(script.includes('TEAM_ID="<TEAM_ID>"'), 'dry-run 下团队探测须用占位 id');
  assert.ok(script.includes('PROJECT_ID="<PROJECT_ID>"'), 'dry-run 下项目探测须用占位 id');
});
