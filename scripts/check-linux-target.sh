#!/usr/bin/env bash
# 在本机验证 Linux 目标的编译与 lint —— 比等 CI 快一个数量级。
#
# # 为什么需要
#
# 本项目的 CI 有 Linux job，而开发机是 macOS。两者差异造成的失败**只在 CI 上
# 出现**，本地全绿毫无预测力（§3.26/§3.28 连续踩过：全局 git 身份、平台门控
# 的死代码、跨平台测试）。而每轮 CI 往返约 5 分钟，还受 GitHub API 匿名配额
# 限制（60 次/小时，本项目实测经常耗尽）。
#
# 交叉编译把这条回路压到约 30 秒，且不消耗任何配额。
#
# # 边界（很重要，别误以为它能替代 CI）
#
# **只有不依赖系统库的 crate 能这么验**：
#
# - `kcode-bridge` / `kcode-domain`：✅ 纯逻辑，可直接 clippy
# - `kcode-app`：❌ **取决于本机是否装了 Linux 的 C 交叉编译器**
#   （`x86_64-linux-gnu-gcc`）。它的构建依赖会经 cc-rs 编译 C 代码，
#   缺工具时失败在 "failed to find tool"——那是**工具链问题，不是代码问题**。
#   本脚本会如实区分这两种失败（见下方判定），而不是一律报红。
# - `kcode-desktop`：❌ 需要 GTK / WebKit 的 pkg-config，交叉时
#   `glib-sys` 的 build script 失败。它的 Linux 行为只能在 CI 上验证。
#
# 另外它**不运行测试**（只编译与 lint）——需要真实 Linux 行为的断言
# （命令执行、沙箱）仍只能在 CI 上跑。
#
# 用法：
#   bash scripts/check-linux-target.sh            # 全部可交叉的 crate
#   bash scripts/check-linux-target.sh kcode-bridge  # 指定 crate
set -uo pipefail

# ⚠️ 本脚本内所有变量展开都用 ${VAR} 花括号形式。
# 原因：中文/全角字符紧跟在变量名后时，bash 会把多字节字节并入变量名
# （`"$TARGET）"` → 变量名变成 `TARGET）`），在 `set -u` 下报
# "unbound variable"。这个坑在本项目已踩过三次（verify-codex-version.sh、
# 本脚本），统一用 ${} 是最省事的免疫方式。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="x86_64-unknown-linux-gnu"

# 需要系统库、不参与交叉的 crate
SKIP="kcode-desktop"

CARGO="${CARGO:-cargo}"
if ! command -v "$CARGO" >/dev/null 2>&1; then
  for c in "$HOME/.cargo/bin/cargo" /usr/local/bin/cargo /opt/homebrew/bin/cargo; do
    [[ -x "$c" ]] && { CARGO="$c"; break; }
  done
fi
if ! command -v "$CARGO" >/dev/null 2>&1 && [[ ! -x "$CARGO" ]]; then
  echo "✗ 未找到 cargo" >&2
  exit 2
fi

# 目标未安装时给出**可照做**的指引，而不是让 cargo 报一堆无关错误
if ! rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
  if command -v rustup >/dev/null 2>&1; then
    echo "· 正在安装 Linux 目标 $TARGET …"
    rustup target add "$TARGET" || { echo "✗ 安装失败" >&2; exit 2; }
  else
    echo "✗ 未安装 rustup，无法添加 $TARGET" >&2
    echo "  手动安装：rustup target add $TARGET" >&2
    exit 2
  fi
fi

# 收集要检查的 crate：默认取 workspace 全部成员，减去 SKIP
if [[ -n "${1:-}" ]]; then
  PKGS=("$1")
else
  PKGS=()
  while IFS= read -r p; do
    name=$(sed -n 's/^name[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$ROOT/$p/Cargo.toml" | head -1)
    [[ "$name" == "$SKIP" ]] && continue
    [[ -n "$name" ]] && PKGS+=("$name")
  done < <(sed -n '/^members/,/]/p' "$ROOT/Cargo.toml" | grep -oE '"[^"]+"' | tr -d '"')
fi

echo "════════ Linux 目标检查（${TARGET}）════════"
echo "跳过：${SKIP}（需要 GTK/WebKit，交叉编译不可行——它的 Linux 行为只能在 CI 验证）"
echo ""

FAIL=0
SKIPPED_TOOLCHAIN=0
for pkg in "${PKGS[@]}"; do
  echo "── ${pkg} ──"
  OUT="$("$CARGO" clippy -p "$pkg" --all-targets --target "$TARGET" -- -D warnings 2>&1)"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  ✓ ${pkg}：编译与 lint 均通过"
    continue
  fi
  # 区分「本机缺交叉工具链」与「代码在 Linux 上真有问题」——
  # 前者不该让脚本报红，否则这个工具会变成噪音源（狼来了）。
  if grep -qE 'failed to find tool|No such file or directory \(os error 2\)|failed to run custom build command' <<<"$OUT"; then
    echo "  ⚠ ${pkg}：本机缺交叉工具链（C 编译器 / 系统库），无法在此验证"
    echo "      这不是代码问题；该 crate 的 Linux 行为请在 CI 上确认。"
    echo "      首行错误：$(grep -m1 -E '^(error|  error)' <<<"$OUT" | head -1)"
    SKIPPED_TOOLCHAIN=1
    continue
  fi
  echo "$OUT" | tail -20
  echo "  ✗ ${pkg}：见上方错误（这正是 CI 上会看到的）" >&2
  FAIL=1
done

echo ""
if [[ $FAIL -ne 0 ]]; then
  echo "✗ 存在 Linux 目标下的**代码问题**——CI 的 rust job 会失败" >&2
  exit 1
fi
echo "✓ 可验证的 crate 在 Linux 目标下通过"
if [[ $SKIPPED_TOOLCHAIN -eq 1 ]]; then
  echo "  （部分 crate 因本机缺交叉工具链未验证——见上方 ⚠）"
fi
echo "  提醒：这不运行测试；依赖系统库的 crate 与真实 Linux 行为仍需 CI"
