# assets/

## tist.ini
- 来源：https://raw.githubusercontent.com/byJoey/test/refs/heads/main/tist.ini
- 拉取时间：2026-11-05（VM 本地 curl，HTTP 200）
- 大小：5,248 B
- sha256：3d089ac52f2ce7c3a09bc0af16d56eb5fe9c716687286c05aedf3715980ef11a
- 用途：原 `src/engine.mjs` 里 `远程配置网址` 常量指向的静态规则清单（Clash ruleset 列表）。
  本 fork 已改指本仓库内该文件（`raw.githubusercontent.com/tony188/cfnew-panel/main/assets/tist.ini`），
  不再拉 byJoey 仓库的副本。
- 注意：该文件内部的 ruleset URL 仍指向 ACL4SSR / cmliu / juewuy 等第三方仓库
  （由使用该 ini 的 Clash 客户端在拉规则时访问，不由面板/Worker 拉取）。
  本文件当前在代码里只被注入管理页、未被其他代码消费（定义后无引用）。
