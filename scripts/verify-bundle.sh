#!/usr/bin/env bash
# 校验打包产物可独立运行。
#
# # 为什么需要它
#
# 应用在开发期通过 `node_modules` 定位 codex 二进制——那是构建环境的路径。
# 打包成 .app 后该路径不存在，若没把二进制打进包，或代码没查资源目录，
# **发布版会启动即失败**，而所有单元测试仍然全绿（它们跑在仓库里）。
#
# 本脚本做两件事：
#   1. 静态检查：.app 内是否含 codex 二进制
#   2. 动态检查：脱离仓库启动，确认进程存活且用的是包内二进制
#
# 用法：bash scripts/verify-bundle.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/target/release/bundle/macos/KCode.app"
BIN="$APP/Contents/MacOS/kcode-desktop"

echo "════════ 打包产物校验 ════════"

if [[ ! -d "$APP" ]]; then
  echo "✗ 未找到 $APP" >&2
  echo "  请先运行: npm run tauri build" >&2
  exit 3
fi

FAIL=0

# ── 1. 静态：包内是否含二进制 ──────────────────────────────────────────
STAGED="$APP/Contents/Resources/binaries/codex"
if [[ -x "$STAGED" ]]; then
  printf '✓ 包内含 codex 二进制（%.0f MB）\n' "$(du -m "$STAGED" | cut -f1)"
else
  echo "✗ 包内缺少 codex 二进制：$STAGED" >&2
  echo "  发布版将无法启动。检查 tauri.conf.json 的 bundle.resources，" >&2
  echo "  以及 scripts/stage-codex-binary.sh 是否在构建前执行。" >&2
  FAIL=1
fi

# ── 2. 动态：脱离仓库启动 ──────────────────────────────────────────────
echo
echo "── 脱离仓库启动（cwd=/tmp，不设 KCODE_REPO_ROOT）──"
WORKSPACE="$(mktemp -d)"
trap 'rm -rf "$WORKSPACE"' EXIT

# 需要 git 仓库，否则应用会提示需要信任
(cd "$WORKSPACE" && git init -q && echo x > a.txt && git add -A \
  && git -c user.email=v@b -c user.name=v commit -qm init) 2>/dev/null

# 先清掉可能存在的旧实例，否则会检测到上一个进程的残留
pkill -f 'kcode-desktop' 2>/dev/null || true
pkill -f 'codex app-server --stdio' 2>/dev/null || true
sleep 1

LOG="$(mktemp)"
(cd /tmp && "$BIN" "$WORKSPACE" >"$LOG" 2>&1 &)
sleep 8

APPPID="$(pgrep -f "kcode-desktop $WORKSPACE" | head -1 || true)"
# 只认「本应用资源目录内」的 codex 进程；系统里可能有别的实例
CODEXPID="$(pgrep -f 'KCode.app/Contents/Resources/binaries/codex app-server' | head -1 || true)"

if [[ -z "$APPPID" ]]; then
  echo "✗ 应用未存活（脱离仓库启动失败）" >&2
  echo "  日志：" >&2
  head -10 "$LOG" | sed 's/^/    /' >&2
  FAIL=1
else
  echo "✓ 应用进程存活 (PID $APPPID)"
fi

if [[ -n "$CODEXPID" ]]; then
  echo "✓ app-server 使用包内二进制"
elif [[ -n "$APPPID" ]]; then
  # 应用活着但没有 app-server 子进程 —— 说明它没找到二进制，
  # 只是还没来得及退出（fatal 对话框会阻塞）。
  echo "✗ 应用存活但未启动 app-server —— 很可能没找到 codex 二进制" >&2
  if grep -q '未找到 codex 二进制' "$LOG" 2>/dev/null; then
    echo "  日志确认：$(grep '未找到 codex 二进制' "$LOG" | head -1)" >&2
  fi
  FAIL=1
else
  echo "✗ 应用未存活且无 app-server" >&2
  FAIL=1
fi

# ── 清理 ────────────────────────────────────────────────────────────────
[[ -n "$APPPID" ]] && kill "$APPPID" 2>/dev/null
pkill -f 'codex app-server --stdio' 2>/dev/null
rm -f "$LOG"

echo
if [[ $FAIL -eq 0 ]]; then
  echo "✓ 打包产物可独立运行"
else
  echo "✗ 打包产物校验失败" >&2
fi
exit $FAIL
