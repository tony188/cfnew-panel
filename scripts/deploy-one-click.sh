#!/usr/bin/env bash
# CFnew 一键部署脚本（Phase 1 ④）。
#
# 一条命令部署 Worker + 面板。顺序：UUID → KV → Worker →（可选自定义域名）
# → Vercel 环境变量 w → 面板部署 → 关 Deployment Protection → 验收。
#
# 输入只走环境变量，token 永不入仓、永不回显到日志、永不出现在命令行参数里
# （curl 鉴权走临时配置文件，wrangler / Vercel CLI 读环境变量）。
#
# 必填：
#   CLOUDFLARE_API_TOKEN  Cloudflare API token（权限：Workers Scripts:Edit、
#                           Workers KV Storage:Edit；自定义域名绑定另需 Zone:DNS:Edit）
#   CF_ACCOUNT_ID         Cloudflare 账号 ID
#   VERCEL_TOKEN          Vercel token（须有读写本项目环境变量与部署的权限）
# 二选一（至少一组）：
#   VERCEL_ORG_ID + VERCEL_PROJECT_ID   首次跑时用这两个 link 现有项目；
#   或已存在 .vercel/project.json（vercel link 一次生成，该文件不入仓）
# 可选：
#   CFNEW_ADMIN_PASSWORD  管理密码（8–128 字符）。给了才做“设密码→登录→读订阅令牌→
#                           验 /api/config 与 /sub 三格式”的全套验收，并输出新形态订阅链接；
#                           不给则只验三端根路径，设密码与订阅链接请走管理页手动完成。
#   CFNEW_UUID            原 UUID（仅用于本地 .cfnew-state 丢失且线上 Worker 已存在时恢复）
#   CFNEW_WORKER_NAME     Worker 服务名（默认 cfnew）
#   CFNEW_KV_NAME         KV 名（默认 cfnew-config，绑定名固定 C）
#   CFNEW_CUSTOM_DOMAIN   自定义域名（如 cfnew.example.com）。只在域名已接入 Cloudflare
#                           区域时尝试绑定；否则只输出手动步骤，不阻塞部署。
#   WRANGLER_BIN / VERCEL_BIN   CLI 路径（默认 wrangler / vercel；仅供本地验证覆盖）
#   CF_API_BASE / VERCEL_API_BASE  API 根地址（默认官方地址；仅供本地验证覆盖）
#
# 用法：
#   CLOUDFLARE_API_TOKEN=... CF_ACCOUNT_ID=... VERCEL_TOKEN=... \
#     VERCEL_ORG_ID=... VERCEL_PROJECT_ID=... \
#     bash scripts/deploy-one-click.sh [--dry-run]
#
# 状态文件 .cfnew-state（gitignored）是 UUID 与 KV id 的唯一本地记录，丢了等于丢了
# 管理入口与全部节点凭证，只能轮换重建——请备份。二次跑幂等：不轮换 UUID、不重建 KV、
# 不丢配置、不清空快照键。
#
# 退出码：0 全部通过；非 0 任一步失败即停（set -euo pipefail），不继续、不静默跳过。
set -euo pipefail

SCRIPT_VERSION="1.0.0"
TMPDIR="${TMPDIR:-/tmp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$ROOT/worker"
STATE_FILE="$ROOT/.cfnew-state"
WRANGLER_TOML="$WORKER_DIR/wrangler.toml"
KV_PLACEHOLDER="__CFNEW_KV_ID__"

WORKER_NAME="${CFNEW_WORKER_NAME:-cfnew}"
KV_NAME="${CFNEW_KV_NAME:-cfnew-config}"
CUSTOM_DOMAIN="${CFNEW_CUSTOM_DOMAIN:-}"
ADMIN_PASSWORD="${CFNEW_ADMIN_PASSWORD:-}"

WRANGLER_BIN="${WRANGLER_BIN:-wrangler}"
VERCEL_BIN="${VERCEL_BIN:-vercel}"
CF_API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
VERCEL_API_BASE="${VERCEL_API_BASE:-https://api.vercel.com}"

DRY_RUN=0
UUID_OVERRIDE="${CFNEW_UUID:-}"
WORKER_URL=""
PANEL_URL=""
SUB_URL=""
UUID_VALUE=""
KV_ID=""
TEAM_ID=""
PROJECT_ID=""
COOKIE_JAR=""
CURL_CFG_CF=""
CURL_CFG_VC=""

say() { printf '==> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() { printf '!! 失败：%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：
  bash scripts/deploy-one-click.sh [--dry-run] [--uuid <原UUID>] [--help]

  --dry-run   只打印将执行的命令（密钥与 token 均以 *** 显示），不执行、不写状态文件
  --uuid      本地 .cfnew-state 丢失且线上 Worker 已存在时，提供原 UUID 恢复
  --help      显示本帮助

必填环境变量：CLOUDFLARE_API_TOKEN、CF_ACCOUNT_ID、VERCEL_TOKEN，
以及 VERCEL_ORG_ID + VERCEL_PROJECT_ID（或已存在 .vercel/project.json）。
可选：CFNEW_ADMIN_PASSWORD、CFNEW_WORKER_NAME、CFNEW_KV_NAME、CFNEW_CUSTOM_DOMAIN。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --uuid) [ $# -ge 2 ] || die "--uuid 需要一个值"; UUID_OVERRIDE="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "未知参数：$1（见 --help）" ;;
  esac
done

# run：dry-run 感知的命令执行。参数里绝不出现密钥/token/密码/UUID 明文。
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '+ %s\n' "$*"; return 0; fi
  "$@"
}

# run_quiet：输出不打印的命令（如管道传值）。$1 为 dry-run 时显示的脱敏命令。
run_quiet() {
  local display="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then printf '+ %s\n' "$display"; return 0; fi
  "$@"
}

# api_curl <cfg> <method> <url> <outfile> [data]：带鉴权的 API 调用（鉴权走临时配置文件，
# 不进 argv、不进日志）。成功返回 HTTP 状态码。dry-run 时只打印脱敏命令。
# cfg 为 cf（Cloudflare token）或 vc（Vercel token）。
api_curl() {
  local cfg="$1" method="$2" url="$3" outfile="$4" data="${5:-}"
  local cfg_file
  case "$cfg" in
    cf) cfg_file="$CURL_CFG_CF" ;;
    vc) cfg_file="$CURL_CFG_VC" ;;
    *) die "api_curl 内部错误：未知 cfg $cfg" ;;
  esac
  if [ "$DRY_RUN" = 1 ]; then
    if [ -n "$data" ]; then
      printf '+ curl -s -X %s %s -H "Authorization: Bearer ***" -d BODY-FILE\n' "$method" "$url"
    else
      printf '+ curl -s -X %s %s -H "Authorization: Bearer ***"\n' "$method" "$url"
    fi
    return 0
  fi
  local code
  if [ -n "$data" ]; then
    code="$(curl -s -o "$outfile" -w '%{http_code}' -X "$method" "$url" -K "$cfg_file" -H 'Content-Type: application/json' -d "$data")" || code="000"
  else
    code="$(curl -s -o "$outfile" -w '%{http_code}' -X "$method" "$url" -K "$cfg_file")" || code="000"
  fi
  printf '%s' "$code"
}

# check_json <file> <jq-filter>：jq 取值；取不到或文件不是 JSON 时 die。
check_json() {
  local file="$1" filter="$2"
  local value
  value="$(jq -r "$filter" "$file" 2>/dev/null)" || die "解析失败（非 JSON）：$file"
  [ -n "$value" ] && [ "$value" != "null" ] || die "字段缺失：$filter（见 $file）"
  printf '%s' "$value"
}

is_uuid() { [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; }
is_kv_id() { [[ "$1" =~ ^[0-9a-f]{32}$ ]]; }

# write_state：原子写状态文件（0600）。存 UUID 与 KV id，不存任何 token/密码。
write_state() {
  if [ "$DRY_RUN" = 1 ]; then
    say "dry-run：不写 .cfnew-state（将存 uuid/kvId，不显示值）"
    return 0
  fi
  local tmp="$STATE_FILE.tmp.$$"
  jq -n --arg uuid "$UUID_VALUE" --arg kvId "$KV_ID" --arg kvName "$KV_NAME" --arg worker "$WORKER_NAME" \
    '{uuid:$uuid, kvId:$kvId, kvName:$kvName, workerName:$worker}' > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# ---------- 前置自检 ----------
preflight() {
  say "前置自检"
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "缺 CLOUDFLARE_API_TOKEN（Cloudflare 仪表板 → My Profile → API Tokens 新建；权限见脚本头）"
  [ -n "${CF_ACCOUNT_ID:-}" ] || die "缺 CF_ACCOUNT_ID（Cloudflare 仪表板右下角 Account ID）"
  [ -n "${VERCEL_TOKEN:-}" ] || die "缺 VERCEL_TOKEN（Vercel 仪表板 → Settings → Tokens 新建）"
  if [ -n "$ADMIN_PASSWORD" ]; then
    local len="${#ADMIN_PASSWORD}"
    { [ "$len" -ge 8 ] && [ "$len" -le 128 ]; } || die "CFNEW_ADMIN_PASSWORD 长度须为 8–128 个字符"
  fi
  if [ -n "$UUID_OVERRIDE" ]; then
    is_uuid "$UUID_OVERRIDE" || die "--uuid / CFNEW_UUID 不是合法 UUID 格式"
  fi
  command -v node >/dev/null || die "缺 Node.js（须 22+；https://nodejs.org/）"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
    || die "Node 版本须 >= 22，当前：$(node --version)"
  command -v jq >/dev/null || die "缺 jq（Debian/Ubuntu：sudo apt install jq）"
  command -v curl >/dev/null || die "缺 curl"
  command -v "$WRANGLER_BIN" >/dev/null || die "缺 wrangler（npx --yes wrangler --version 可拉取，或 npm i -g wrangler）"
  command -v "$VERCEL_BIN" >/dev/null || die "缺 Vercel CLI 33+（npm i -g vercel）"
  local vver
  vver="$("$VERCEL_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || true
  [ -n "$vver" ] || die "读不到 Vercel CLI 版本"
  local vmajor="${vver%%.*}"
  [ "$vmajor" -ge 33 ] || die "Vercel CLI 须 >= 33，当前：$vver"
  [ -f "$WORKER_DIR/_worker.js" ] || die "缺 worker/_worker.js（仓内 vendor 的 core）"
  [ -f "$WRANGLER_TOML" ] || die "缺 worker/wrangler.toml（仓内模板）"
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" VERCEL_TOKEN
  # curl 鉴权配置文件（0600，用完即删；token 永不出现在 argv 与日志里）。
  # CF 与 Vercel 各一份（token 不同，不可混用）。
  if [ "$DRY_RUN" = 0 ]; then
    CURL_CFG_CF="$(mktemp)"; CURL_CFG_VC="$(mktemp)"
    chmod 600 "$CURL_CFG_CF" "$CURL_CFG_VC"
    printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" > "$CURL_CFG_CF"
    printf 'header = "Authorization: Bearer %s"\n' "$VERCEL_TOKEN" > "$CURL_CFG_VC"
    trap 'rm -f "$CURL_CFG_CF" "$CURL_CFG_VC" "$COOKIE_JAR"' EXIT
  fi
  say "前置自检通过（Node $(node --version)，Vercel CLI $vver）"
}

# ---------- 步骤 ① UUID：复用 / 恢复 / 生成 ----------
step_uuid() {
  say "步骤 ① 生成/复用 UUID"
  if [ -f "$STATE_FILE" ]; then
    UUID_VALUE="$(jq -r '.uuid // empty' "$STATE_FILE" 2>/dev/null)" || die ".cfnew-state 损坏（非 JSON），请备份后删除重建"
    [ -n "$UUID_VALUE" ] || die ".cfnew-state 里没有 uuid，请备份后删除重建"
    is_uuid "$UUID_VALUE" || die ".cfnew-state 里的 uuid 格式不对"
    say "复用本地 .cfnew-state 里的 UUID（不轮换）"
    return 0
  fi
  if [ -n "$UUID_OVERRIDE" ]; then
    UUID_VALUE="$UUID_OVERRIDE"
    say "使用提供的原 UUID 恢复（写入 .cfnew-state）"
    write_state
    return 0
  fi
  # 无本地状态：只确认线上 Worker 是否存在（只确认存在，不返回值）。
  local probe="$TMPDIR/cf-probe.$$.json"
  local code
  code="$(api_curl cf GET "$CF_API_BASE/accounts/$CF_ACCOUNT_ID/workers/scripts/$WORKER_NAME" "$probe")"
  if [ "$DRY_RUN" = 1 ]; then
    say "dry-run：假设线上 Worker 不存在，将生成新 UUID（见下行命令）"
    printf '+ cat /proc/sys/kernel/random/uuid  # 或 node -e crypto.randomUUID()\n'
    UUID_VALUE="<UUID>"
    return 0
  fi
  case "$code" in
    200)
      die "线上 Worker $WORKER_NAME 已存在，但本地没有 .cfnew-state（UUID 唯一记录丢了）。请提供原 UUID 再跑：CFNEW_UUID=<原UUID> bash $0，或 --uuid <原UUID>。不静默生成新 UUID（否则旧管理入口与全部节点凭证作废）。"
      ;;
    404)
      say "线上 Worker 不存在，生成新 UUID"
      ;;
    *)
      die "查线上 Worker 失败（HTTP $code），请检查 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID 权限。响应：$(head -c 300 "$probe")"
      ;;
  esac
  if [ -r /proc/sys/kernel/random/uuid ]; then
    UUID_VALUE="$(cat /proc/sys/kernel/random/uuid)"
  else
    UUID_VALUE="$(node -e 'console.log(require("crypto").randomUUID())')"
  fi
  is_uuid "$UUID_VALUE" || die "生成的 UUID 格式不对：$UUID_VALUE"
  write_state
  say "新 UUID 已写入 .cfnew-state（请备份该文件）"
}

# ---------- 步骤 ② KV：复用 / 新建，替换 wrangler.toml 占位符 ----------
step_kv() {
  say "步骤 ② 建/复用 KV（$KV_NAME，绑定名 C）"
  if [ -f "$STATE_FILE" ]; then
    KV_ID="$(jq -r '.kvId // empty' "$STATE_FILE" 2>/dev/null)" || true
  fi
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ %s kv namespace list\n' "$WRANGLER_BIN"
    printf '+ %s kv namespace create %s   # 仅当按名查不到时\n' "$WRANGLER_BIN" "$KV_NAME"
    printf '+ 替换 worker/wrangler.toml 里的 %s 为查到的 KV id\n' "$KV_PLACEHOLDER"
    KV_ID="<KV_ID>"
    return 0
  fi
  local list_out="$TMPDIR/kv-list.$$.txt"
  run "$WRANGLER_BIN" kv namespace list > "$list_out" \
    || die "wrangler kv namespace list 失败，请检查 token 权限（Workers KV Storage:Edit）"
  local found=""
  if jq -e . "$list_out" >/dev/null 2>&1; then
    found="$(jq -r --arg name "$KV_NAME" '.[] | select(.title == $name) | .id' "$list_out" | head -1)" || true
  else
    die "wrangler kv namespace list 未返回 JSON，无法按名查找。请升级 wrangler 后重试。输出头：$(head -c 300 "$list_out")"
  fi
  if [ -n "$found" ]; then
    KV_ID="$found"
    say "复用已有 KV $KV_NAME"
  else
    say "KV $KV_NAME 不存在，新建"
    local create_out="$TMPDIR/kv-create.$$.txt"
    run "$WRANGLER_BIN" kv namespace create "$KV_NAME" > "$create_out" \
      || die "wrangler kv namespace create 失败"
    KV_ID="$(grep -oE 'id = "[0-9a-f]{32}"' "$create_out" | head -1 | sed -E 's/id = "//; s/"//')" || true
    [ -n "$KV_ID" ] || die "新建 KV 后解析不到 id，请检查输出：$(head -c 500 "$create_out")"
  fi
  is_kv_id "$KV_ID" || die "KV id 格式不对：$KV_ID"
  # 替换 wrangler.toml 里的占位符（或已填的不同 id）。只改这一行，不动其他内容。
  if grep -q "$KV_PLACEHOLDER" "$WRANGLER_TOML"; then
    sed -i "s/$KV_PLACEHOLDER/$KV_ID/" "$WRANGLER_TOML"
    say "已把 KV id 写入 worker/wrangler.toml（该 id 不是密钥，可提交）"
  elif grep -q "id = \"$KV_ID\"" "$WRANGLER_TOML"; then
    say "worker/wrangler.toml 里的 KV id 已是本次查到的，无须改"
  else
    sed -i -E "s/id = \"[0-9a-f]{32}\"/id = \"$KV_ID\"/" "$WRANGLER_TOML"
    say "worker/wrangler.toml 里的 KV id 已更新为本次查到的"
  fi
  write_state
}

# ---------- 步骤 ③ 部署 Worker ----------
step_deploy_worker() {
  say "步骤 ③ 部署 Worker（$WORKER_NAME）"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ (cd worker && printf "%%s" "$UUID" | %s secret put u)   # 值经 stdin，不进命令行\n' "$WRANGLER_BIN"
    printf '+ (cd worker && %s deploy)\n' "$WRANGLER_BIN"
    printf '+ curl -s %s/accounts/<ACCOUNT_ID>/workers/subdomain -H "Authorization: Bearer ***"   # 取 workers.dev 子域名\n' "$CF_API_BASE"
    WORKER_URL="<WORKER_URL>"
    return 0
  fi
  do_secret_put() { ( cd "$WORKER_DIR" && printf '%s' "$UUID_VALUE" | "$WRANGLER_BIN" secret put u ); }
  run_quiet "(cd worker && printf '%s' \"\$UUID\" | $WRANGLER_BIN secret put u)" do_secret_put \
    || die "wrangler secret put u 失败（u 以 secret 注入，绝不写进 wrangler.toml）"
  local deploy_out="$TMPDIR/wrangler-deploy.$$.txt"
  (cd "$WORKER_DIR" && run "$WRANGLER_BIN" deploy > "$deploy_out" 2>&1) \
    || { cat "$deploy_out" >&2; die "wrangler deploy 失败"; }
  WORKER_URL="$(grep -oE "https://$WORKER_NAME\.[A-Za-z0-9.-]+\.workers\.dev" "$deploy_out" | head -1)" || true
  if [ -z "$WORKER_URL" ]; then
    # 本地验证用：部署输出里含 localhost 地址时直接采用（生产部署的输出里永远不会出现）。
    WORKER_URL="$(grep -oE 'http://(127\.0\.0\.1|localhost):[0-9]+' "$deploy_out" | head -1)" || true
  fi
  if [ -z "$WORKER_URL" ]; then
    local sub_out="$TMPDIR/cf-subdomain.$$.json"
    local code
    code="$(api_curl cf GET "$CF_API_BASE/accounts/$CF_ACCOUNT_ID/workers/subdomain" "$sub_out")"
    [ "$code" = 200 ] || die "取 workers.dev 子域名失败（HTTP $code）"
    local subdomain
    subdomain="$(check_json "$sub_out" '.result.subdomain')"
    WORKER_URL="https://$WORKER_NAME.$subdomain.workers.dev"
  fi
  say "Worker 地址：$WORKER_URL"
}

# ---------- 步骤 ④ 自定义域名（可选，尽力而为） ----------
step_custom_domain() {
  [ -n "$CUSTOM_DOMAIN" ] || return 0
  say "步骤 ④ 自定义域名：$CUSTOM_DOMAIN（尽力绑定，失败只给手动步骤，不阻塞部署）"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ curl -s %s/zones?name=%s -H "Authorization: Bearer ***"   # 查域名是否已接入 CF 区域\n' "$CF_API_BASE" "$CUSTOM_DOMAIN"
    printf '+ curl -s -X PUT %s/accounts/<ACCOUNT_ID>/workers/domains -H "Authorization: Bearer ***" -d BODY-FILE\n' "$CF_API_BASE"
    return 0
  fi
  local zone_out="$TMPDIR/cf-zone.$$.json"
  local root="${CUSTOM_DOMAIN#*.}"
  local zone_id=""
  local code
  code="$(api_curl cf GET "$CF_API_BASE/zones?name=$CUSTOM_DOMAIN" "$zone_out")"
  if [ "$code" = 200 ]; then
    zone_id="$(jq -r '.result[0].id // empty' "$zone_out" 2>/dev/null)" || true
  fi
  if [ -z "$zone_id" ] && [ "$root" != "$CUSTOM_DOMAIN" ]; then
    code="$(api_curl cf GET "$CF_API_BASE/zones?name=$root" "$zone_out")"
    if [ "$code" = 200 ]; then
      zone_id="$(jq -r '.result[0].id // empty' "$zone_out" 2>/dev/null)" || true
    fi
  fi
  if [ -z "$zone_id" ]; then
    warn "域名 $CUSTOM_DOMAIN 未接入 Cloudflare 区域，脚本无法自动绑定。"
    warn "手动步骤：Cloudflare 仪表板 → 域名 → 添加站点，把 $CUSTOM_DOMAIN 的 NS 接入 Cloudflare；然后 Workers → $WORKER_NAME → Settings → Domains → Add Custom Domain，填 $CUSTOM_DOMAIN。"
    warn "继续用 workers.dev 地址部署，之后可再跑一次脚本（幂等）补绑定。"
    return 0
  fi
  local dom_out="$TMPDIR/cf-domain.$$.json"
  code="$(api_curl cf PUT "$CF_API_BASE/accounts/$CF_ACCOUNT_ID/workers/domains" "$dom_out" \
    "{\"hostname\":\"$CUSTOM_DOMAIN\",\"service\":\"$WORKER_NAME\",\"environment\":\"production\"}")"
  if [ "$code" = 200 ] || [ "$code" = 201 ]; then
    WORKER_URL="https://$CUSTOM_DOMAIN"
    say "自定义域名已绑定：$WORKER_URL"
  else
    warn "绑定自定义域名失败（HTTP $code），继续用 workers.dev 地址。"
    warn "手动步骤：Workers → $WORKER_NAME → Settings → Domains → Add Custom Domain，填 $CUSTOM_DOMAIN；确认区域 $root 的 DNS 已托管在 Cloudflare。"
  fi
}

# ---------- 步骤 ⑤ Vercel：link → env w → deploy ----------
step_vercel_link() {
  say "步骤 ⑤ link Vercel 项目"
  if [ -f "$ROOT/.vercel/project.json" ]; then
    PROJECT_ID="$(jq -r '.projectId // empty' "$ROOT/.vercel/project.json" 2>/dev/null)" || true
    TEAM_ID="$(jq -r '.orgId // empty' "$ROOT/.vercel/project.json" 2>/dev/null)" || true
    [ -n "$PROJECT_ID" ] || die ".vercel/project.json 里没有 projectId，请删掉它重跑 vercel link"
    say "已 link 现有 Vercel 项目（.vercel/project.json）"
    return 0
  fi
  [ -n "${VERCEL_ORG_ID:-}" ] || die "缺 VERCEL_ORG_ID（或先跑一次 vercel link 生成 .vercel/project.json；该文件不入仓）"
  [ -n "${VERCEL_PROJECT_ID:-}" ] || die "缺 VERCEL_PROJECT_ID（或先跑一次 vercel link 生成 .vercel/project.json；该文件不入仓）"
  TEAM_ID="$VERCEL_ORG_ID"
  PROJECT_ID="$VERCEL_PROJECT_ID"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ %s link --yes --scope <TEAM> --project <PROJECT_ID>\n' "$VERCEL_BIN"
    return 0
  fi
  run "$VERCEL_BIN" link --yes --scope "$TEAM_ID" --project "$PROJECT_ID" \
    || die "vercel link 失败（检查 VERCEL_TOKEN 与组织/项目 ID）"
}

step_vercel_env() {
  say "步骤 ⑤a 持久化环境变量 w（Production）"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ printf "%%s" "<WORKER_URL>" | %s env add w -e production --force   # 值经 stdin；--force 使二次跑幂等\n' "$VERCEL_BIN"
    return 0
  fi
  # 值经 stdin，不进命令行；--force 使重跑直接覆盖旧值（w 须始终跟踪 Worker 地址）。
  printf '%s' "$WORKER_URL" | run "$VERCEL_BIN" env add w -e production --force -p "$PROJECT_ID" \
    || die "vercel env add w 失败（w 须持久化，勿用 --env 只对当次部署有效）"
  say "w 已持久化：$WORKER_URL"
}

step_vercel_deploy() {
  say "步骤 ⑤b 部署面板（Production）"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ %s deploy --prod --yes --verify   # --verify 等部署就绪再返回\n' "$VERCEL_BIN"
    PANEL_URL="<PANEL_URL>"
    return 0
  fi
  local deploy_out="$TMPDIR/vercel-deploy.$$.txt"
  run "$VERCEL_BIN" deploy --prod --yes --verify > "$deploy_out" 2>&1 \
    || { cat "$deploy_out" >&2; die "vercel deploy --prod 失败"; }
  PANEL_URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.vercel\.app' "$deploy_out" | tail -1)" || true
  if [ -z "$PANEL_URL" ]; then
    # 本地验证用：部署输出里含 localhost 地址时直接采用（生产部署的输出里永远不会出现）。
    PANEL_URL="$(grep -oE 'http://(127\.0\.0\.1|localhost):[0-9]+' "$deploy_out" | tail -1)" || true
  fi
  [ -n "$PANEL_URL" ] || { cat "$deploy_out" >&2; die "部署成功但解析不到面板地址"; }
  say "面板地址：$PANEL_URL"
}

# ---------- 步骤 ⑥ 关 Deployment Protection ----------
step_protection() {
  say "步骤 ⑥ 关 Deployment Protection（Vercel Authentication）"
  local team_q=""
  [ -n "$TEAM_ID" ] && team_q="?teamId=$TEAM_ID"
  local resp="$TMPDIR/vercel-patch.$$.json"
  local code
  code="$(api_curl vc PATCH "$VERCEL_API_BASE/v9/projects/$PROJECT_ID$team_q" "$resp" '{"ssoProtection":null}')"
  if [ "$DRY_RUN" = 1 ]; then
    say "dry-run：假设 PATCH 成功（失败时脚本会给手动路径，不静默当作已关）"
    return 0
  fi
  if [ "$code" = 200 ]; then
    say "Deployment Protection 已关"
  else
    warn "API 关 Deployment Protection 失败（HTTP $code），请手动关："
    warn "Vercel 仪表板 → Project → Settings → Deployment Protection → Vercel Authentication → Off。"
    warn "不静默当作已关——下一步验收（未登录打开根路径返回 hello）会直接判失败。"
  fi
}

# ---------- 工具：未登录 GET，返回 "<http_code> <body>" ----------
http_get() {
  local url="$1"
  if [ "$DRY_RUN" = 1 ]; then printf '+ curl -s %s\n' "$url"; return 0; fi
  local body_file="$TMPDIR/http-get.$$.txt"
  local code
  code="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 30 "$url")" || code="000"
  printf '%s %s' "$code" "$(cat "$body_file")"
}

# ---------- 步骤 ⑦ 验收 ----------
step_verify() {
  say "步骤 ⑦ 验收"
  local fail=0
  # ⑦-1 三端根路径 200 hello。
  local u
  for u in "$WORKER_URL" "$PANEL_URL"; do
    if [ "$DRY_RUN" = 1 ]; then
      printf '+ curl -s %s/   # 期望：200 hello\n' "$u"
      continue
    fi
    local out code body
    out="$(http_get "$u/")"
    code="${out%% *}"; body="${out#* }"
    if [ "$code" = 200 ] && [ "$body" = "hello" ]; then
      say "通过：$u/ → 200 hello"
    else
      warn "失败：$u/ → HTTP $code（期望 200 hello；若是 Vercel 登录页，说明 Deployment Protection 还没关）"
      fail=1
    fi
  done
  if [ -n "$CUSTOM_DOMAIN" ] && [ "$WORKER_URL" = "https://$CUSTOM_DOMAIN" ] && [ "$DRY_RUN" = 0 ]; then
    local out2 code2 body2
    out2="$(http_get "https://$CUSTOM_DOMAIN/")"
    code2="${out2%% *}"; body2="${out2#* }"
    if [ "$code2" = 200 ] && [ "$body2" = "hello" ]; then say "通过：自定义域 → 200 hello"; else warn "失败：自定义域 → HTTP $code2"; fail=1; fi
  fi
  # ⑦-2/⑦-3 需要管理密码：设密码 → 登录 → 验配置与订阅。没给密码则只给手动步骤。
  if [ -z "$ADMIN_PASSWORD" ]; then
    warn "未提供 CFNEW_ADMIN_PASSWORD，跳过 /api/config 与 /sub 验收（须登录才能验）。"
    warn "手动做：打开管理页 $PANEL_URL/$UUID_VALUE，立即设管理密码（抢占窗口）；设完后在“订阅令牌”区复制新订阅地址，用 OpenClash / SingX 导入验证。"
    [ "$fail" = 0 ] || die "验收失败（见上）"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ POST %s/<UUID>/api/auth/setup {"password":"***"}   # 已设过则 409，继续登录\n' "$PANEL_URL"
    printf '+ POST %s/<UUID>/api/auth/login {"password":"***"}   # 会话进 HttpOnly cookie，不进正文\n' "$PANEL_URL"
    printf '+ GET %s/<UUID>/api/config   # 期望：scu=空、epi=no、customDNS=1.1.1.1、configVersion 为数字\n' "$PANEL_URL"
    printf '+ GET %s/<UUID>/api/auth/sub-token   # 取订阅令牌（令牌只存 KV，不显示）\n' "$PANEL_URL"
    printf '+ GET %s/sub/<TOKEN>?target=base64|clash|singbox   # 三格式可解析、节点无非 Worker 主机的 workers.dev\n' "$PANEL_URL"
    printf '+ GET %s/<UUID>/sub   # 期望：404（旧 UUID 形态已废）\n' "$PANEL_URL"
    return 0
  fi
  COOKIE_JAR="$(mktemp)"
  chmod 600 "$COOKIE_JAR"
  local mgmt="$PANEL_URL/$UUID_VALUE"
  local resp="$TMPDIR/auth.$$.json"
  AUTH_BODY_FILE="$TMPDIR/auth-body.$$.json"  # 全局：EXIT trap 退出时才展开，local 会越界
  # 密码写进临时文件（0600）再 -d @文件，不进命令行参数与日志。
  jq -n --arg pw "$ADMIN_PASSWORD" '{password:$pw}' > "$AUTH_BODY_FILE"
  chmod 600 "$AUTH_BODY_FILE"
  trap 'rm -f "$CURL_CFG_CF" "$CURL_CFG_VC" "$COOKIE_JAR" "$AUTH_BODY_FILE"' EXIT
  local code
  code="$(curl -s -o "$resp" -w '%{http_code}' --max-time 30 -X POST "$mgmt/api/auth/setup" \
    -H 'Content-Type: application/json' -d @"$AUTH_BODY_FILE")" || code="000"
  case "$code" in
    200) say "管理密码已设置（订阅令牌已自动生成）" ;;
    409) say "管理密码已存在，直接登录" ;;
    *) die "设管理密码失败（HTTP $code）：$(head -c 300 "$resp")" ;;
  esac
  code="$(curl -s -c "$COOKIE_JAR" -o "$resp" -w '%{http_code}' --max-time 30 -X POST "$mgmt/api/auth/login" \
    -H 'Content-Type: application/json' -d @"$AUTH_BODY_FILE")" || code="000"
  [ "$code" = 200 ] || die "登录失败（HTTP $code）：$(head -c 300 "$resp")"
  grep -q "sessionToken" "$resp" && die "登录响应正文含 sessionToken（③ 要求只进 cookie）——实现异常，停下"
  code="$(curl -s -b "$COOKIE_JAR" -o "$resp" -w '%{http_code}' --max-time 30 "$mgmt/api/config")" || code="000"
  [ "$code" = 200 ] || die "读 /api/config 失败（HTTP $code）：$(head -c 300 "$resp")"
  local scu epi dns cv
  scu="$(jq -r '.scu // "?"' "$resp")" || scu="?"
  epi="$(jq -r '.epi // "?"' "$resp")" || epi="?"
  dns="$(jq -r '.customDNS // "?"' "$resp")" || dns="?"
  cv="$(jq -r '.configVersion // "?"' "$resp")" || cv="?"
  if [ "$scu" = "" ] && [ "$epi" = "no" ] && [ "$dns" = "https://1.1.1.1/dns-query" ] && [[ "$cv" =~ ^[0-9]+$ ]]; then
    say "通过：/api/config（scu 为空、epi=no、customDNS=1.1.1.1、configVersion=$cv，① 版本机制在）"
  else
    warn "失败：/api/config 不符预期（scu='$scu' epi='$epi' customDNS='$dns' configVersion='$cv'）"
    fail=1
  fi
  code="$(curl -s -b "$COOKIE_JAR" -o "$resp" -w '%{http_code}' --max-time 30 "$mgmt/api/auth/sub-token")" || code="000"
  [ "$code" = 200 ] || die "取订阅令牌失败（HTTP $code）"
  local token
  token="$(jq -r '.token // empty' "$resp")" || true
  [ -n "$token" ] || die "订阅令牌为空（应由设密码时自动生成）"
  local sub_base="$PANEL_URL/sub/$token"
  local t
  # Worker 主机：订阅里节点地址/sni 若含 workers.dev，只能是它自己（无自定义域名时原生节点与 sni 就是它）。
  # 规则集数据里 workers.dev 是公开 geosite 域名条目，不是泄漏，不得全文 grep（实测会误报）。
  local worker_host
  worker_host="$(printf '%s' "$WORKER_URL" | sed -E 's#^[a-z][a-z0-9+.-]*://##; s#[:/].*##')"
  for t in base64 clash singbox; do
    local sub_out="$TMPDIR/sub-$t.$$.txt"
    code="$(curl -s -o "$sub_out" -w '%{http_code}' --max-time 60 "$sub_base?target=$t")" || code="000"
    if [ "$code" != 200 ]; then warn "失败：/sub?target=$t → HTTP $code"; fail=1; continue; fi
    case "$t" in
      base64)
        if python3 - "$sub_out" "$worker_host" <<'PYEOF' 2>/dev/null
import base64,sys,re
d=base64.b64decode(open(sys.argv[1],'rb').read()).decode('utf-8',errors='replace')
assert 'vless://' in d, 'no vless'
hosts=re.findall(r'([A-Za-z0-9.-]+\.workers\.dev)', d)
bad=[h for h in hosts if h != sys.argv[2]]
assert not bad, 'unexpected workers.dev hosts: %s' % bad
print('links:', d.count('://'))
PYEOF
        then
          say "通过：/sub base64 可解析、节点无非 Worker 主机的 workers.dev"
        else
          warn "失败：/sub base64 内容不符预期"; fail=1
        fi
        ;;
      clash)
        if grep -q "proxies:" "$sub_out" && python3 - "$sub_out" "$worker_host" <<'PYEOF' 2>/dev/null
import sys,re
hosts=[]
for line in open(sys.argv[1]):
    m=re.match(r'\s*(server|servername|sni)\s*:\s*(\S+)', line)
    if m: hosts.append(m.group(2).strip('"').strip("'"))
assert hosts, 'no servers found'
bad=[h for h in hosts if 'workers.dev' in h and h != sys.argv[2]]
assert not bad, 'unexpected workers.dev servers: %s' % bad
print('servers:', len(hosts))
PYEOF
        then
          say "通过：/sub clash 可解析、节点无非 Worker 主机的 workers.dev"
        else
          warn "失败：/sub clash 内容不符预期"; fail=1
        fi
        ;;
      singbox)
        if python3 - "$sub_out" "$worker_host" <<'PYEOF' 2>/dev/null
import json,sys
d=json.load(open(sys.argv[1]))
hosts=set()
def walk(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k in ('server','server_name') and isinstance(v,str): hosts.add(v)
            else: walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
walk(d.get('outbounds',[]))
bad=[h for h in hosts if 'workers.dev' in h and h != sys.argv[2]]
assert not bad, 'unexpected workers.dev servers: %s' % bad
print('outbound servers:', len(hosts))
PYEOF
        then
          say "通过：/sub sing-box 可解析、节点无非 Worker 主机的 workers.dev"
        else
          warn "失败：/sub sing-box 内容不符预期"; fail=1
        fi
        ;;
    esac
  done
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$PANEL_URL/$UUID_VALUE/sub")" || code="000"
  if [ "$code" = 404 ]; then
    say "通过：旧 UUID 形态 /sub → 404（③ 已废）"
  else
    warn "失败：旧 UUID 形态 /sub → HTTP $code（期望 404）"; fail=1
  fi
  SUB_URL="$sub_base"
  [ "$fail" = 0 ] || die "验收失败（见上）"
}

# ---------- 主流程 ----------
main() {
  say "CFnew 一键部署 v$SCRIPT_VERSION（仓库：$ROOT）"
  [ "$DRY_RUN" = 1 ] && say "dry-run 模式：只打印命令，不执行、不写状态文件"
  cd "$ROOT" || die "进不去仓库目录：$ROOT"
  preflight
  step_uuid
  step_kv
  step_deploy_worker
  step_custom_domain
  step_vercel_link
  step_vercel_env
  step_vercel_deploy
  step_protection
  step_verify
  echo
  say "部署完成"
  echo "  Worker：$WORKER_URL"
  echo "  面板：$PANEL_URL"
  echo "  管理页：$PANEL_URL/$UUID_VALUE"
  if [ -n "$SUB_URL" ]; then
    echo "  订阅：$SUB_URL"
  else
    echo "  订阅：请先在管理页设管理密码，再到“订阅令牌”区复制新订阅地址"
  fi
  echo
  echo "  注意：管理页与订阅链接都含钥匙，勿转发他人。"
  if [ -z "$ADMIN_PASSWORD" ]; then
    echo "  注意：部署后请立刻打开管理页设管理密码（抢占窗口：设密码前任何人知道管理页地址都能先设密码）。"
  fi
  echo "  状态文件 .cfnew-state 是 UUID 与 KV id 的唯一本地记录，请备份。"
}

main "$@"
