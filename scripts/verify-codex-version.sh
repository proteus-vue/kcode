#!/usr/bin/env bash
# 校验 codex CLI 版本与二进制哈希，确保构建可复现、且不低于安全修复基线。
#
# 用法：
#   bash scripts/verify-codex-version.sh            # 校验
#   bash scripts/verify-codex-version.sh --record   # 记录当前哈希到 codex.lock.json
#
# 退出码：0 通过；1 校验失败；2 环境不满足。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/codex.lock.json"
# 安全基线：CVE-2025-59532（GHSA-w5fx-fh39-j5rw）修复版本。
# 低于此版本会因沙箱路径配置缺陷，把模型生成的 cwd 当作可写根。
MIN_VERSION="0.39.0"

RECORD=0
[[ "${1:-}" == "--record" ]] && RECORD=1

# ── 定位二进制 ────────────────────────────────────────────────────────────────
find_binary() {
  local candidates=(
    "$ROOT/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
    "$ROOT/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex"
    "$ROOT/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
    "$ROOT/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex"
    "$ROOT/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
  )
  local c
  for c in "${candidates[@]}"; do
    [[ -f "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

hash_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

semver_gte() {
  # 比较两个点分版本号：$1 >= $2 返回 0
  local a b
  IFS='.' read -r -a a <<< "${1%%-*}"
  IFS='.' read -r -a b <<< "${2%%-*}"
  local i
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    if (( x > y )); then return 0; fi
    if (( x < y )); then return 1; fi
  done
  return 0
}

BIN="$(find_binary)" || {
  echo "✗ 未找到 codex 二进制。请先运行: npm install" >&2
  exit 2
}

ACTUAL_VERSION="$("$BIN" --version 2>/dev/null | awk '{print $NF}')"
ACTUAL_HASH="$(hash_file "$BIN")"

echo "codex 二进制 : $BIN"
echo "实际版本     : $ACTUAL_VERSION"
echo "实际 SHA256  : $ACTUAL_HASH"

if [[ "$RECORD" == "1" ]]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const out = {
      comment: "codex CLI 锁定记录。修改此文件必须在 PR 中说明理由并跑通契约测试。",
      version: process.argv[2],
      sha256: process.argv[3],
      securityBaseline: process.argv[4],
      advisory: "GHSA-w5fx-fh39-j5rw / CVE-2025-59532",
      recordedAt: new Date().toISOString(),
    };
    fs.writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
  ' "$LOCK" "$ACTUAL_VERSION" "$ACTUAL_HASH" "$MIN_VERSION"
  echo "✓ 已写入 $LOCK"
  exit 0
fi

FAIL=0

# ── 1. 安全基线 ──────────────────────────────────────────────────────────────
if semver_gte "$ACTUAL_VERSION" "$MIN_VERSION"; then
  echo "✓ 版本满足安全基线 (>= $MIN_VERSION)"
else
  echo "✗ 版本 ${ACTUAL_VERSION} 低于安全基线 ${MIN_VERSION}（CVE-2025-59532 未修复）" >&2
  FAIL=1
fi

# ── 2. package.json 与 lock 文件一致性 ───────────────────────────────────────
PINNED="$(node -p "require('$ROOT/package.json').devDependencies['@openai/codex']" 2>/dev/null || echo '')"
if [[ -n "$PINNED" ]]; then
  # package.json 中锁定的版本应当与二进制版本一致（npm 会解析平台子包为同版本）
  if [[ "$PINNED" == "$ACTUAL_VERSION" ]]; then
    echo "✓ package.json 锁定版本与二进制一致 ($PINNED)"
  else
    echo "⚠ package.json 锁定 ${PINNED}，但二进制为 ${ACTUAL_VERSION}（平台子包可能与主包版本不同，需人工确认）"
  fi
else
  echo "⚠ 无法从 package.json 读取 @openai/codex 版本"
fi

# ── 3. 哈希记录比对 ──────────────────────────────────────────────────────────
if [[ -f "$LOCK" ]]; then
  LOCKED_HASH="$(node -p "require('$LOCK').sha256" 2>/dev/null || echo '')"
  LOCKED_VER="$(node -p "require('$LOCK').version" 2>/dev/null || echo '')"
  if [[ "$ACTUAL_HASH" == "$LOCKED_HASH" ]]; then
    echo "✓ 二进制 SHA256 与 codex.lock.json 一致"
  else
    echo "✗ 二进制 SHA256 与锁定记录不一致" >&2
    echo "    锁定: $LOCKED_VER / $LOCKED_HASH" >&2
    echo "    实际: $ACTUAL_VERSION / $ACTUAL_HASH" >&2
    echo "    若为有意升级，请复核版本后执行: bash scripts/verify-codex-version.sh --record" >&2
    FAIL=1
  fi
else
  echo "⚠ 尚无 ${LOCK}，跳过哈希比对。执行 --record 以建立锁定记录。"
fi

exit $FAIL
