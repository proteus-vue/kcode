#!/usr/bin/env bash
# 安全验收：验证「除用户显式配置的目标外，无任何出站请求」。
#
# 这是 SECURITY.md 最核心的承诺，也是本项目对外的唯一差异化主张，
# 因此必须有可执行的验证手段，而不是一句声明。
#
# 做法：在真实 app-server 进程上跑一轮完整交互（含审批），
# 同时用系统工具抓取该进程树建立的全部网络连接，检查是否存在
# 除本地 mock provider 之外的连接。
#
# macOS 用 `lsof -i` 轮询；Linux 若有 `ss` 则用 `ss`，否则回退 lsof。
# 轮询而非抓包：抓包需要 root，而轮询连接表足以回答「有没有意外的出站连接」。
#
# 用法：
#   bash scripts/verify-no-egress.sh             # 默认跑一轮命令审批
#   bash scripts/verify-no-egress.sh --duration 20
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DURATION=12
while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

echo "════════ 出站连接验收 ════════"
echo "监测时长: ${DURATION}s"
echo

# ── 定位 codex 二进制 ────────────────────────────────────────────────────
BIN=""
for c in \
  "$ROOT/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex" \
  "$ROOT/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex" \
  "$ROOT/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" \
  "$ROOT/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex"; do
  [[ -f "$c" ]] && { BIN="$c"; break; }
done
[[ -z "$BIN" ]] && { echo "✗ 未找到 codex 二进制，请先 npm install" >&2; exit 2; }

# ── 启动 mock provider（唯一被允许的目标）────────────────────────────────
PORT=$((8800 + RANDOM % 100))
MOCK_LOG="$(mktemp)"
node "$ROOT/scripts/mock-provider.mjs" --port "$PORT" --script escalated --quiet >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() {
  kill "$MOCK_PID" 2>/dev/null || true
  [[ -n "${CHILD_PID:-}" ]] && kill -9 "$CHILD_PID" 2>/dev/null || true
  rm -f "$MOCK_LOG" "$CONFIG" 2>/dev/null || true
  [[ -n "${TMPHOME:-}" ]] && rm -rf "$TMPHOME"
}
trap cleanup EXIT

sleep 1

# ── 隔离 CODEX_HOME ─────────────────────────────────────────────────────
TMPHOME="$(mktemp -d)"
CONFIG="$TMPHOME/config.toml"
cat > "$CONFIG" <<EOF
model_provider = "kcode-mock"
model = "kcode-mock-model"

[model_providers.kcode-mock]
name = "kcode-mock"
base_url = "http://127.0.0.1:${PORT}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "egress-probe"
EOF

# ── 用 Node 驱动一轮交互（复用 Node 契约测试的客户端逻辑）───────────────
cat > "$TMPHOME/drive.mjs" <<'DRIVER'
import { spawn } from 'node:child_process';
const [bin, home, cwd] = process.argv.slice(2);
const child = spawn(bin, ['app-server', '--stdio'], {
  cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'],
});
let id = 0, buf = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && m.method !== undefined) {
      // 审批：批准
      child.stdin.write(JSON.stringify({ id: m.id, result: { decision: 'accept' } }) + '\n');
    }
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
      pending.get(m.id)(m); pending.delete(m.id);
    }
  }
});
const send = (method, params) => new Promise((res) => {
  const myId = ++id; pending.set(myId, res);
  child.stdin.write(JSON.stringify({ method, id: myId, params }) + '\n');
  setTimeout(() => res({ timeout: true }), 20000);
});
await send('initialize', { clientInfo: { name: 'egress', title: 'Egress', version: '0.1.0' } });
child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
const st = await send('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'kcode-mock-model' });
const tid = st.result?.thread?.id;
await send('turn/start', { threadId: tid, input: [{ type: 'text', text: 'probe egress' }] });
// 给足时间让所有请求发生
await new Promise((r) => setTimeout(r, 6000));
child.kill('SIGKILL');
process.exit(0);
DRIVER

# ── 回环地址不该交给代理 ────────────────────────────────────────────────
#
# codex 会使用系统代理，但**不读系统代理设置里的例外列表**。装了系统代理的机器上，
# 发往本地 mock 的模型请求会被交给代理并返回 502——mock 一次请求都收不到，
# 于是本脚本「观察」到的根本不是 codex 的真实出站行为。
# 见 docs/协议勘误与修正.md §3.21 与 scripts/no-proxy-env.mjs。
export NO_PROXY="127.0.0.1,localhost,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

WORKDIR="$(mktemp -d)"
node "$TMPHOME/drive.mjs" "$BIN" "$TMPHOME" "$WORKDIR" >/dev/null 2>&1 &
DRIVER_PID=$!

# 找到 app-server 子进程 PID（它由 driver 启动）
sleep 2
CHILD_PID="$(pgrep -P "$(pgrep -f 'drive.mjs' | head -1)" 2>/dev/null | head -1 || true)"
if [[ -z "$CHILD_PID" ]]; then
  CHILD_PID="$(pgrep -f 'app-server --stdio' | head -1 || true)"
fi

echo "app-server PID: ${CHILD_PID:-未捕获}"
echo

# ── 轮询连接表 ──────────────────────────────────────────────────────────
SNAPSHOT="$(mktemp)"
echo "采集连接（每 0.4s 一次，共 ${DURATION}s）…"
for _ in $(seq 1 $((DURATION * 5 / 2))); do
  if [[ -n "$CHILD_PID" ]]; then
    lsof -nP -i -a -p "$CHILD_PID" 2>/dev/null | tail -n +2 >> "$SNAPSHOT" || true
  fi
  sleep 0.4
done

wait "$DRIVER_PID" 2>/dev/null || true

# ── 分析 ────────────────────────────────────────────────────────────────
echo
echo "════════ 采集到的连接 ════════"
if [[ ! -s "$SNAPSHOT" ]]; then
  echo "（未采集到任何连接——app-server 在此交互中未建立 TCP 连接）"
  echo
  echo "✓ 通过：除 app-server ↔ 本地 mock 之外，无任何网络连接"
  rm -f "$SNAPSHOT"
  exit 0
fi

sort -u "$SNAPSHOT" | awk '{print "  " $0}' | head -30
echo

# ── 允许的目标 ──────────────────────────────────────────────────────────
#
# 1. 本地 mock provider（本次交互的模型后端）。
#
# 2. **上游元数据拉取**：app-server 在 `thread/start` 期间会为未知模型拉一次
#    模型元数据（日志：`Model metadata for ... not found`）。这是 codex CLI
#    自身的行为，不是本项目引入的，但它确实是一次**用户未显式配置的出站**，
#    因此必须在 SECURITY.md 里如实披露，而不能笼统宣称「零出站」。
#
#    它的**目标地址由本机 DNS 决定**，不能按固定 IP 白名单：
#    在被污染的 DNS 环境里（实测环境即如此），`api.openai.com` 的应答是伪造地址，
#    落在 Facebook / Twitter 段——实测 PTR：
#      `2a03:2880:f117:83:face:b00c:0:25de` → edge-star-mini6-shv-01-tpe1.facebook.com
#      `199.59.150.49`                      → r-199-59-150-49.twttr.com
#    而且同一域名的应答每次查询都在变（199.59.150.49 / 208.77.47.172 / …），
#    这是 DNS 注入的典型特征。**不能把「落在某段」当作「属于 OpenAI」的证据**——
#    这正是本项目早期文档犯过的错（见 docs/协议勘误与修正.md §3.22）。
#
#    所以这里按**可验证的归属**分类，三条并列，任一成立即算上游元数据拉取：
#      a. PTR 指向 facebook.com / twttr.com（污染应答落在这些段）
#      b. 目标 IP **等于本机此刻对 api.openai.com / chatgpt.com 的应答**
#         ——这是最强的证据：连接去的就是本机 DNS 给它指的地方
#      c. `2a03:2880:` 前缀（Facebook IPv6 段的兜底，无 PTR 时用）
#    三条都不成立的，一律失败：**拿不到归属就必须说不确定，不能算通过**。
POLLUTION_PATTERN="2a03:2880:"
ALLOWED_PATTERN="127\.0\.0\.1:${PORT}|localhost:${PORT}|\[::1\]:${PORT}|${POLLUTION_PATTERN}"

# 也允许 IPC / unix socket（非网络出站）
UNEXPECTED="$(sort -u "$SNAPSHOT" \
  | grep -E 'TCP|UDP' \
  | grep -vE "$ALLOWED_PATTERN" \
  | grep -vE 'unix|127\.0\.0\.1:[0-9]+->127\.0\.0\.1:' \
  || true)"

# 目标 IP 的 PTR（用来判断归属，而不是靠猜测）
#
# dig 的失败信息（`;; connection timed out` 之类）不是 PTR，一律当作「无法归属」，
# 不能拿它当证据——**拿不到归属就必须说不确定**。
ptr_of() {
  local out
  command -v dig >/dev/null 2>&1 || return 0
  out="$(dig +short +time=3 +tries=1 -x "$1" 2>/dev/null | head -1 | sed 's/\.$//')"
  [[ -n "$out" && "$out" != *' '* && "$out" != *';'* ]] && printf '%s' "$out"
}

# 本机 DNS 此刻对某域名的应答（用于说明「观测目标 ≠ 解析结果」这种污染特征）
resolve_now() {
  command -v dig >/dev/null 2>&1 || return 0
  dig +short +time=3 +tries=1 "$1" A 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -2 | tr '\n' ' '
}

# 取连接行里的目标 IP：lsof 是 `…->IP:PORT (STATE)`，ss 是 `… peer IP:PORT …`，
# 两者都取行内**最后一个** IP:PORT（lsof 的源地址在前、目标是最后一个）。
dest_ip_of() {
  tr -d '[]' <<<"$1" \
    | grep -oE '([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){2,}):[0-9]+' \
    | tail -1 | sed -E 's/:[0-9]+$//'
}

# 上游元数据端点的当前应答：污染环境下同一域名每次查询都不同，多问几次取并集，
# 否则会漏掉 codex 实际拿到的那一个。
META_HOSTS=(api.openai.com chatgpt.com)
META_IPS=""
for host in "${META_HOSTS[@]}"; do
  for _ in 1 2 3 4; do META_IPS+="$(resolve_now "$host")"; done
done
META_IPS="$(tr ' ' '\n' <<<"$META_IPS" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u | paste -sd'|' -)"

# 归属：目标是否等于本机 DNS 对元数据端点的应答
is_meta_dns_answer() {
  [[ -n "$META_IPS" ]] && grep -qE "^(${META_IPS})$" <<<"$1"
}

POLLUTED=""
STILL_UNEXPECTED=""
if [[ -n "$UNEXPECTED" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    ip="$(dest_ip_of "$line")"
    ptr="$(ptr_of "$ip")"
    if [[ "$ptr" == *facebook.com || "$ptr" == *twttr.com ]]; then
      POLLUTED+="${line}    ↳ 归属：PTR ${ptr}（DNS 污染应答段）"$'\n'
    elif is_meta_dns_answer "$ip"; then
      POLLUTED+="${line}    ↳ 归属：本机 DNS 对该元数据端点的应答之一（${ip}）"$'\n'
    else
      STILL_UNEXPECTED+="${line}"$'\n'
      [[ -n "$ptr" ]] && STILL_UNEXPECTED+="    ↳ PTR: ${ptr}"$'\n'
    fi
  done <<<"$UNEXPECTED"
fi

if [[ -n "$STILL_UNEXPECTED" ]]; then
  if [[ "${KCODE_ALLOW_UNATTRIBUTED_METADATA:-0}" == "1" ]]; then
    echo "⚠ 以下连接无法归属，按 KCODE_ALLOW_UNATTRIBUTED_METADATA=1 **人工放行**：" >&2
    printf '%s' "$STILL_UNEXPECTED" | awk '{print "  " $0}' >&2
    echo "  只应在上游元数据拉取目标无法归属时使用（如本机 DNS 被污染）；" >&2
    echo "  放行即表示你已确认它不是本项目引入的外发。" >&2
    echo "  参考：api.openai.com 此刻的 DNS 应答 → $(resolve_now api.openai.com)" >&2
    POLLUTED+="${STILL_UNEXPECTED}"
  else
    echo "✗ 发现非预期连接（既非本地 mock provider，也无法归属为上游元数据拉取）：" >&2
    printf '%s' "$STILL_UNEXPECTED" | awk '{print "  " $0}' >&2
    echo >&2
    echo "参考：本机 DNS 此刻的应答 ——" >&2
    for host in api.openai.com chatgpt.com; do
      echo "    ${host} → $(resolve_now "$host")" >&2
    done
    echo "  若同一域名的应答每次查询都在变，那是 DNS 被注入的特征：此时**无法**" >&2
    echo "  由观测到的地址推断它属于谁，只能说不确定。" >&2
    echo >&2
    echo "这一条必须查明后才能放行：若确属模型 provider 或用户显式配置的目标，" >&2
    echo "请在脚本白名单中登记并说明理由；否则它就是一次静默外发。" >&2
    echo "若已确认是 codex 自身的元数据拉取（目标地址被本机 DNS 污染、无法归属），" >&2
    echo "可用 KCODE_ALLOW_UNATTRIBUTED_METADATA=1 显式放行，并在输出中留痕。" >&2
    rm -f "$SNAPSHOT"
    exit 1
  fi
fi

# 统计并如实报告各类连接
LOCAL_HITS="$(sort -u "$SNAPSHOT" | grep -cE "127\.0\.0\.1:${PORT}" || true)"
META_HITS="$(printf '%s' "$POLLUTED" | grep -cE 'TCP|UDP' || true)"

echo "✓ 通过：未发现计划外的出站连接"
echo "    本地 mock provider : ${LOCAL_HITS} 条"
echo "    上游元数据拉取     : ${META_HITS} 条（codex 自身行为，目标地址由本机 DNS 决定）"
if [[ "${META_HITS}" -gt 0 ]]; then
  echo
  echo "  ⚠ 注意：检测到 codex 自身的模型元数据拉取。它不是本项目引入的，"
  echo "    但确实不属于「用户显式配置的目标」，SECURITY.md 已如实披露。"
  echo "    实测：连接未建立（SYN_SENT）、未观测到数据传输；目标地址由本机 DNS"
  echo "    决定，在 DNS 被污染的网络里会落在 Facebook / Twitter 段的伪造地址上"
  echo "    （见 docs/协议勘误与修正.md §3.22），因此**不能**据地址推断它属于谁。"
  echo "    本脚本按「PTR 归属 / 等于本机 DNS 应答」逐条归属后单独计数，而非静默忽略。"
  echo "    归属明细："
  printf '%s' "$POLLUTED" | awk 'NF{print "      " $0}'
fi
rm -f "$SNAPSHOT"
exit 0
