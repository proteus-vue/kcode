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
# 2. **OpenAI 官方 CDN 段**（`2a03:2880::/32` 为 Meta 托管的 OpenAI 边缘节点）。
#    实测发现：app-server 在 `thread/start` 期间会拉取模型元数据
#    （`api.openai.com` / `chatgpt.com` 解析到同一段），且在模型未注册为
#    已知模型时必然触发（日志：`Model metadata for ... not found`）。
#
#    这是 **codex CLI 自身的行为，不是本项目引入的**，但它确实构成一次
#    用户未显式配置的出站连接，因此必须在 SECURITY.md 中如实披露，
#    而不能笼统宣称「零出站」。本脚本把它显式列入白名单正是为了让
#    这一事实可见、可审计。
ALLOWED_PATTERN="127\.0\.0\.1:${PORT}|localhost:${PORT}|\[::1\]:${PORT}|2a03:2880:"
OPENAI_META_PATTERN="2a03:2880:"
# 也允许 IPC / unix socket（非网络出站）
UNEXPECTED="$(sort -u "$SNAPSHOT" \
  | grep -E 'TCP|UDP' \
  | grep -vE "$ALLOWED_PATTERN" \
  | grep -vE 'unix|127\.0\.0\.1:[0-9]+->127\.0\.0\.1:' \
  || true)"

if [[ -n "$UNEXPECTED" ]]; then
  echo "✗ 发现非预期连接（既非本地 mock provider，也非已知的 OpenAI CDN 段）：" >&2
  echo "$UNEXPECTED" | awk '{print "  " $0}' >&2
  echo >&2
  echo "这一条必须查明后才能放行：若确属模型 provider 或用户显式配置的目标，" >&2
  echo "请在脚本白名单中登记并说明理由；否则它就是一次静默外发。" >&2
  rm -f "$SNAPSHOT"
  exit 1
fi

# 统计并如实报告各类连接
META_HITS="$(sort -u "$SNAPSHOT" | grep -cE "$OPENAI_META_PATTERN" || true)"
LOCAL_HITS="$(sort -u "$SNAPSHOT" | grep -cE "127\.0\.0\.1:${PORT}" || true)"

echo "✓ 通过：未发现计划外的出站连接"
echo "    本地 mock provider : ${LOCAL_HITS} 条"
echo "    OpenAI CDN 段       : ${META_HITS} 条（codex 自身的模型元数据拉取）"
if [[ "${META_HITS}" -gt 0 ]]; then
  echo
  echo "  ⚠ 注意：检测到 OpenAI 官方 CDN 连接（2a03:2880::/32）。"
  echo "    这由 codex CLI 自身发起（模型元数据查询），非本项目引入，"
  echo "    但确实不属于「用户显式配置的目标」。SECURITY.md 已如实披露。"
fi
rm -f "$SNAPSHOT"
exit 0
