#!/usr/bin/env bash
# 把当前平台的 codex 二进制暂存到 Tauri 的 resources 目录，供打包使用。
#
# # 为什么需要它
#
# 应用通过 `locate_binary` 在 `node_modules` 里找 codex 二进制——那是
# **开发期**的路径。打包成 .app 后该路径不存在，应用会启动失败。
# 早先的版本只能靠 `KCODE_REPO_ROOT` 环境变量指向仓库才能运行，
# 那不是可发布的形态。
#
# 本脚本把当前平台的二进制（codex + rg）复制到
# `crates/kcode-desktop/binaries/`，由 tauri.conf.json 的 bundle.resources
# 打进 app。选择平台二进制而非全部平台的，是为避免把 6 个平台的
# 二进制（每个约 225MB）都塞进包里。
#
# 用法：
#   bash scripts/stage-codex-binary.sh            # 暂存
#   bash scripts/stage-codex-binary.sh --clean    # 清理暂存
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/crates/kcode-desktop/binaries"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$STAGE"
  echo "✓ 已清理 $STAGE"
  exit 0
fi

# ── 确定平台包名与 vendor 目录 ──────────────────────────────────────────
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "$UNAME_S-$UNAME_M" in
  Darwin-arm64) PKG="@openai/codex-darwin-arm64"; VENDOR="aarch64-apple-darwin" ;;
  Darwin-x86_64) PKG="@openai/codex-darwin-x64"; VENDOR="x86_64-apple-darwin" ;;
  Linux-aarch64) PKG="@openai/codex-linux-arm64"; VENDOR="aarch64-unknown-linux-musl" ;;
  Linux-x86_64) PKG="@openai/codex-linux-x64"; VENDOR="x86_64-unknown-linux-musl" ;;
  *)
    echo "✗ 不支持的平台: $UNAME_S-$UNAME_M" >&2
    exit 2
    ;;
esac

VENDOR_DIR="$ROOT/node_modules/$PKG/vendor/$VENDOR"
CODEX_BIN="$VENDOR_DIR/bin/codex"
RG_BIN="$VENDOR_DIR/codex-path/rg"
# code-mode-host 是 codex 在「完全访问」档位下会启动的辅助进程。
# 它不随 codex 自动带上：codex 会在自己所在目录旁查找这个名字
# （实测 strings 里有 `codex-code-mode-host`）。
# 缺失的后果不是降级而是**整个轮次失败**：
#   Code Mode is unavailable because failed to spawn code-mode-host ...
#   host executable was not found.
# 这正是「权限档位切到完全访问后什么都跑不起来」的成因。
CODE_MODE_HOST_BIN="$VENDOR_DIR/bin/codex-code-mode-host"

if [[ ! -f "$CODEX_BIN" ]]; then
  echo "✗ 未找到 codex 二进制: $CODEX_BIN" >&2
  echo "  请先运行 npm install" >&2
  exit 2
fi

# ── 暂存 ────────────────────────────────────────────────────────────────
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "平台: $UNAME_S/$UNAME_M"
echo "来源: $VENDOR_DIR"

cp "$CODEX_BIN" "$STAGE/codex"
chmod +x "$STAGE/codex"
printf '  codex  %.0f MB\n' "$(du -m "$STAGE/codex" | cut -f1)"

# code-mode-host：只在完全访问档位用到，但缺了会让该档位完全不可用。
# 与 rg 不同，这里缺失**必须**报出来——否则用户切到完全访问后
# 只会看到每轮都失败，且原因不指向权限档位。
if [[ -f "$CODE_MODE_HOST_BIN" ]]; then
  cp "$CODE_MODE_HOST_BIN" "$STAGE/codex-code-mode-host"
  chmod +x "$STAGE/codex-code-mode-host"
  printf '  code-mode-host  %.1f MB\n' "$(du -m "$STAGE/codex-code-mode-host" | cut -f1)"
else
  echo "  ✗ 未找到 codex-code-mode-host：完全访问档位将无法执行任务" >&2
  echo "    期望路径: $CODE_MODE_HOST_BIN" >&2
fi

# rg 是 codex 用于代码搜索的辅助工具。缺失不致命（codex 会回退到系统 grep），
# 但打包后 .app 里没有 PATH 上的 rg，带上更稳妥。
if [[ -f "$RG_BIN" ]]; then
  cp "$RG_BIN" "$STAGE/rg"
  chmod +x "$STAGE/rg"
  printf '  rg     %.1f MB\n' "$(du -m "$STAGE/rg" | cut -f1)"
else
  echo "  ⚠ 未找到 rg（codex 将回退到系统 grep）"
fi

# ── iOS 输入注入 helper ────────────────────────────────────────────────
#
# 它不是下载来的，而是**本机编译**的（Swift 源码在 crates/kcode-desktop/native/）。
# 放在这里一起暂存，是因为它必须与 codex 一样进 app bundle 才能用。
#
# **失败不中止打包**：这个 helper 只影响 iOS 触摸输入，缺了它 iOS 仍可看画面。
# 而打包本身（生成能用的 .app）是更重要的目标——不让一个可选能力拖垮发布。
# 但必须**明确告警**，而不是静默跳过（那会让「iOS 点不动」无从解释）。
if ! bash "$ROOT/scripts/build-sim-hid.sh"; then
  echo "⚠ kcode-sim-hid 未就绪：打包产物里 iOS 模拟器将只读（可看画面、不能点）" >&2
fi

# 记录来源版本，便于排查「包里的 codex 是哪个版本」
if [[ -f "$ROOT/codex.lock.json" ]]; then
  cp "$ROOT/codex.lock.json" "$STAGE/codex.lock.json"
fi

echo
echo "✓ 已暂存到 $STAGE"
echo "  该目录由 tauri.conf.json 的 bundle.resources 打进 app。"
if [[ -x "$STAGE/kcode-sim-hid" ]]; then
  echo "  · 含 kcode-sim-hid（iOS 触摸注入，走 Apple 私有接口）"
else
  echo "  · 无 kcode-sim-hid：iOS 模拟器将只读"
fi
