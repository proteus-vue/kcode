#!/usr/bin/env bash
# 校验 codex CLI 版本与二进制哈希，确保构建可复现、且不低于安全修复基线。
#
# 用法：
#   bash scripts/verify-codex-version.sh              # 校验
#   bash scripts/verify-codex-version.sh --record     # 记录**当前平台**的哈希
#   bash scripts/verify-codex-version.sh --print-hash # 只打印平台/版本/哈希（供回填）
#
# `--print-hash` 的用途：哈希必须在**目标平台**上算（二进制不同），
# 所以开发机算不出 CI 的 Linux 值。CI 里跑这个选项把值打出来，
# 再回填 codex.lock.json——而不是在本机猜一个。
#
# # 哈希必须按平台记录（这不是放宽校验）
#
# npm 为每个平台装的是**不同的**二进制（darwin-arm64 / linux-x64 / …），
# 哈希自然不同。早先 lock 里只记一个 sha256，等于把「本机 macOS arm64 的
# 那个文件」当成全局唯一——于是同一份 lock 在 macOS 上通过、在 CI 的
# Linux 上必然失败。这个错误与「CI 整个没跑」（勘误 §3.25）叠加，
# 一起被隐藏了 18 次推送：流水线根本没执行，所以没人发现它必然失败。
#
# 现在按 `platforms[<os>-<arch>]` 分别记录，每个平台各自比对；当前平台
# **未记录**时明确提示（而不是静默通过、也不是直接判失败）。
#
# 退出码：0 通过；1 校验失败；2 环境不满足。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/codex.lock.json"
# 安全基线：CVE-2025-59532（GHSA-w5fx-fh39-j5rw）修复版本。
# 低于此版本会因沙箱路径配置缺陷，把模型生成的 cwd 当作可写根。
MIN_VERSION="0.39.0"

RECORD=0
PRINT_HASH=0
case "${1:-}" in
  --record) RECORD=1 ;;
  --print-hash) PRINT_HASH=1 ;;
esac

# 当前平台键：`<uname -s>-<uname -m>` 小写，与 lock 里的写法一致
# （darwin-arm64 / linux-x86_64 / darwin-x86_64 …）。
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"

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
echo "当前平台     : $PLATFORM"
echo "实际版本     : $ACTUAL_VERSION"
echo "实际 SHA256  : $ACTUAL_HASH"

if [[ "$PRINT_HASH" == "1" ]]; then
  # 机器可读：供 CI 日志抓取后回填 lock
  echo "platform=$PLATFORM"
  echo "version=$ACTUAL_VERSION"
  echo "sha256=$ACTUAL_HASH"
  exit 0
fi

if [[ "$RECORD" == "1" ]]; then
  # 只更新**当前平台**那一条，其余平台原样保留——否则在 macOS 上
  # 执行 --record 会把 CI 的 Linux 记录抹掉，重新制造出这个 bug。
  node -e '
    const fs = require("fs");
    const [p, version, hash, baseline, platform] = process.argv.slice(1);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    const platforms = { ...(prev.platforms || {}) };
    // 兼容老格式：顶层的 sha256 是「最初记录的那个平台」的，
    // 迁到 platforms 下时归到 darwin-arm64（见 commit 说明），
    // 之后顶层字段不再写入，避免两份真相。
    if (prev.sha256 && Object.keys(platforms).length === 0) {
      platforms["darwin-arm64"] = { version: prev.version, sha256: prev.sha256 };
    }
    platforms[platform] = { version, sha256: hash };
    const out = {
      comment: prev.comment || "codex CLI 锁定记录。修改此文件必须在 PR 中说明理由并跑通契约测试。",
      version,
      securityBaseline: baseline,
      advisory: "GHSA-w5fx-fh39-j5rw / CVE-2025-59532",
      // 顶层 version 表示「最近一次记录时的版本」；权威值是各平台的 platforms[*].version
      platforms,
      recordedAt: new Date().toISOString(),
    };
    fs.writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
  ' "$LOCK" "$ACTUAL_VERSION" "$ACTUAL_HASH" "$MIN_VERSION" "$PLATFORM"
  echo "✓ 已写入 ${LOCK}（平台 ${PLATFORM}）"
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

# ── 3. 哈希记录比对（按平台）────────────────────────────────────────────────
if [[ -f "$LOCK" ]]; then
  # 先查 platforms[<当前平台>]；查不到再回退到顶层的 sha256（老格式兼容）。
  #
  # 输出用 `|` 分隔，且用 **NONE 哨兵**表示「没有记录」——不能用空串或
  # 0 之类的占位值：`read` 会按空白切分，占位符会落进本应是字段的位置，
  # 于是「未记录」被误判成「不匹配」（这个 bug 被本段自己的分支测试抓到）。
  LOCK_LOOKUP="$(node -e '
    const l = require(process.argv[1]);
    const p = process.argv[2];
    const e = (l.platforms || {})[p];
    if (e) console.log([e.sha256, e.version, "PLATFORM"].join("|"));
    else if (l.sha256) console.log([l.sha256, l.version, "LEGACY"].join("|"));
    else console.log(["NONE", "NONE", "NONE"].join("|"));
  ' "$LOCK" "$PLATFORM" 2>/dev/null || echo "NONE|NONE|NONE")"
  IFS='|' read -r LOCKED_HASH LOCKED_VER HASH_SOURCE <<<"$LOCK_LOOKUP"

  if [[ "$LOCKED_HASH" == "NONE" || -z "$LOCKED_HASH" ]]; then
    # 当前平台没有记录：**明确说出来**。静默通过会让「可复现性」变成空话
    # （CI 首次真跑时发现：Linux 从来没有被记录过）。判失败也过头——
    # 那会让新增平台的人无法先提交；但必须让他看见并补记录。
    echo "⚠ codex.lock.json 未记录平台 ${PLATFORM} 的哈希（已记录：$(
      node -e 'console.log(Object.keys(require(process.argv[1]).platforms || {}).join(", ") || "无")' "$LOCK" 2>/dev/null
    )）"
    echo "    本平台无法比对。如确认无误，请执行: bash scripts/verify-codex-version.sh --record" >&2
  elif [[ "$ACTUAL_HASH" == "$LOCKED_HASH" ]]; then
    echo "✓ 二进制 SHA256 与 codex.lock.json 一致（${PLATFORM}）"
    [[ "$HASH_SOURCE" == "LEGACY" ]] && echo "    （该记录取自顶层旧格式字段，建议用 --record 迁到 platforms.${PLATFORM}）"
  else
    echo "✗ 二进制 SHA256 与锁定记录不一致（${PLATFORM}）" >&2
    echo "    锁定: $LOCKED_VER / $LOCKED_HASH" >&2
    echo "    实际: $ACTUAL_VERSION / $ACTUAL_HASH" >&2
    echo "    若为有意升级，请复核版本后执行: bash scripts/verify-codex-version.sh --record" >&2
    FAIL=1
  fi
else
  echo "⚠ 尚无 ${LOCK}，跳过哈希比对。执行 --record 以建立锁定记录。"
fi

exit $FAIL
