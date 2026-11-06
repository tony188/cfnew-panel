# CFnew 独立面板

[![部署到 Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftony188%2Fcfnew-panel&project-name=cfnew-panel&repository-name=cfnew-panel&env=w&envDescription=Worker%20%E5%9C%B0%E5%9D%80%EF%BC%8C%E5%A6%82%20https%3A%2F%2Fcfnew.%3C%E5%AD%90%E5%9F%9F%E5%90%8D%3E.workers.dev%EF%BC%8C%E9%83%A8%E7%BD%B2%20Worker%20%E5%90%8E%E5%A1%AB%E5%85%A5)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-43853d)](https://nodejs.org/)
[![源码许可](https://img.shields.io/badge/源码许可-署名与禁止冒充原创-blue)](./LICENSE)

把 CFnew 控制台、优选操作和订阅生成放在 Vercel，Cloudflare Worker 只负责代理转发和 KV 配置。节点流量直接连接你自己的 Worker，不经过面板。

## 一键部署

**首选脚本路**：仓内 `scripts/deploy-one-click.sh`，一次配好 token 后一条命令部署 Worker + 面板（见脚本头用法）。Worker 源码已 vendor 在仓内 `worker/`（`_worker.js` + `wrangler.toml`），脚本自动部署，不用再去上游拉 core-only。

**按钮路是全新环境备用路，不复用现有项目**：Vercel Deploy Button 的语义是把源码 clone 成你 GitHub 账号下的一个新仓库、再新建一个 Vercel 项目，不会指向已有的 `tony188/cfnew-panel` 项目，也不会复用已有的面板部署。已部署的用户请走脚本路或 Import 现有仓，**不得点按钮**，否则会得到第二个面板、第二个订阅地址，与现状分叉。

按钮路步骤：

1. 先部署 Worker：可用脚本路只做 Worker 部分，或在 Cloudflare 仪表板新建 Worker、把仓内 `worker/_worker.js` 全文粘进去、绑定 KV（名称 `C`）、以 secret 方式设变量 `u` 为自己的 UUID。已有用户保留原 UUID 和 KV 绑定。
2. 点击上面的 Deploy 按钮，登录 Vercel，按页面提示连接 GitHub 并创建自己的仓库副本；表单里填 `w` 为 Worker 地址（如 `https://cfnew.<子域名>.workers.dev`，不带 UUID/路径/参数）。
3. Application Preset（旧界面叫 Framework）选择 **Other**；如果自动识别成 Node，请改为 Other。根目录保持仓库根目录，无需手填构建命令。点击 Deploy，等待完成。
4. 打开分配的面板域名，首次使用先设管理密码，再登录管理页。
5. 在面板中配置并复制订阅到客户端。订阅使用面板域名；节点的 SNI / Host 与代理入口仍是 Worker。

部署按钮会引导平台登录、Git 授权和创建项目，这些步骤仍需用户在自己的账号完成。项目无需付费数据库或面板 KV。

如果仓库列表为空，先到 Vercel 账号的 Authentication → Sign-in Methods 连接 GitHub，再返回部署页面。

GitHub 中已经有自己的 `cfnew-panel` 仓库时，在 Vercel 的 New Project → Import Git Repository 选择该仓库即可。通过 Git 连接部署后，推送到 `main` 会自动更新正式站；其它分支用于预览。已有源码无需删掉重建。

## 可选变量：w

`w` 设置在 **Vercel 面板项目**的 Settings → Environment Variables，变量名为小写。选择 Production；需要预览也生效时同时选择 Preview。保存后重新部署。

| w 的值 | 入口与行为 |
| --- | --- |
| 不设置或留空 | 公共面板。首页显示 Worker 域名和 UUID / 自定义路径连接表单，可接入任意兼容 Worker。 |
| `https://your-worker.example.com` | 只管理这个 Worker。首页返回 `hello`，不显示连接表单；通过 `https://面板域名/UUID` 或自定义路径进入原控制台。 |

只填 Worker 的 HTTPS 根地址，不带 UUID、路径或查询参数。HTTPS 前缀可省略。无效值会拒绝连接；填写后不能通过换查询参数接入其它 Worker。

`w` 不需要写到 Worker 内核里，也不代替 UUID 验证。面板不能凭这个变量替你隐藏 Worker 的全部网络路径。

固定 Worker 后：

```text
控制台：https://面板域名/你的UUID
订阅：  https://面板域名/sub/<订阅令牌>
Clash： https://面板域名/sub/<订阅令牌>?target=clash
```

家宽链式（`target=vg`）订阅仍可手工拼 URL 生成：`https://面板域名/sub/<订阅令牌>?target=vg`（`jk` 须为 `yes`），管理页不再提供入口。

如果 Worker 的 `d` 是 `/Admin/Panel`，也可用 `https://面板域名/Admin/Panel` 进入。大小写必须一致。登录后地址自动使用稳定的 UUID，后续修改 `d` 不影响当前面板重载和已复制订阅。`d` 是配置入口，`tp` 是代理传输设置。

## 让订阅客户端能访问

先用未登录 Vercel 的浏览器打开面板。若被 Vercel 登录页拦住，在 Settings → Deployment Protection 调整 Vercel Authentication，使使用中的部署域名可公开访问。

浏览器登录 Vercel 后能打开面板，不代表客户端能更新订阅。用实际对外域名验证，不能给订阅链接附上 Vercel 账号令牌。

## 自有服务器与 Docker

Node.js 22：

```bash
git clone https://github.com/tony188/cfnew-panel.git
cd cfnew-panel
npm start
# 可选：固定自己的 Worker
w=https://your-worker.example.com npm start
```

运行不需要 npm 依赖，默认监听 `127.0.0.1:3100`。用 Nginx / Caddy 反代并启用 HTTPS。不要对外开放未加 HTTPS 的管理入口。

Docker：

```bash
docker compose up -d --build
# 固定 Worker 可在 .env 中填写 w，或通过环境变量传给 compose。
```

面板不把 UUID 或配置写入数据库。勾选“记住节点”只保存在当前浏览器；UUID 和订阅地址相当于访问凭据，勿公开分享，反代访问日志建议不记录这些入口。

## 更新与限制

- 一键部署得到自己的仓库副本。更新面板源码后重新部署；修改环境变量也要重新部署。
- 原 WebSocket、XHTTP、出站代理、ECH、IPv6 与客户端订阅生成保留；代理数据面仍由配套核心处理。
- 在线 IP 检测探测接口仍在，延迟是服务器视角；管理页不再提供延迟测试入口。IPv6 节点生成和 Worker 实际连接已验证，不能用服务器视角的检测结果代替客户端测速。
- sing-box 使用 1.12 起的 DNS / 路由格式，内置分流规则，不要求启动时下载规则文件。规则许可见 [NOTICE](./NOTICE.md) 和 `/rules-license`。
- 请求正文上限 1 MiB，大量地址可改用在线列表 URL。健康检查为 `/health`。
- GitHub Pages 只能托管静态页面，不能运行本项目的服务端配置转发、订阅转换和在线检测；本项目使用 Vercel Functions。

## 开发与验证

```bash
npm ci
npm test
```

测试使用内存 KV 与本地隔离 Worker，不访问你的真实 Worker。`CFNEW_ALLOW_PRIVATE=yes` 仅供隔离测试，线上不要设置。

可生成单独的压缩运行包：

```bash
npm run build:vercel -- /一个空目录
```

规则更新：`python3 src/tools/update-singbox-rules.py --revision <完整提交号> --sing-box <可执行文件>`。更新后需验证真实客户端的 DNS、代理联网和分流，再发布。

## 来源与交流

允许任何合法用途的修改、二次开发和 AI 辅助维护。**禁止将基于本项目源码的 AI 改写冒充为与本项目无关的完全原创代码**；改写相同逻辑、换语言、改名或重排结构后，仍须保留来源和版权说明。可以注明自己实际新增的独立贡献。

本版本采用自定义的 [CFnew 源码使用与署名许可](./LICENSE)，不再标为标准 MIT。此前已按 MIT 发布的版本仍按其原许可使用。来源与第三方许可见 [NOTICE.md](./NOTICE.md)，内置规则数据继续遵循其原始许可。


本项目供学习与网络技术研究，请遵守当地法律及所用平台的服务条款。
