#!/usr/bin/env bash
# 编译 iOS 输入注入 helper（kcode-sim-hid）。
#
# # 它是什么
#
# 一个小的 Swift 程序，把触摸/按键注入 iOS 模拟器。`simctl` 没有这个能力
# （它只有截图），所以这是 KCode 的 iOS 画面能交互的唯一途径。
# 实现走 Apple 私有接口的细节见 crates/kcode-desktop/native/sim-hid.swift 头部。
#
# # 为什么要单独一个脚本
#
# 它和 codex 二进制不同：codex 是**下载来的**（npm 包），这个是**本机编译的**。
# 编译产物入不了库（平台相关、且每次编译的哈希都可能不同），所以：
#   · 开发时按需编译一次（本脚本）；
#   · 打包时由 stage-codex-binary.sh 自动调用。
#
# # 签名
#
# `swiftc` 在 Apple Silicon 上会自动产出 **adhoc 签名**的二进制（这是内核要求，
# 不可执行未签名代码）。实测这与 app 自身的签名类别一致（`flags=0x20002
# adhoc,linker-signed`），因此**不需要额外的签名步骤**——发布版要正式签名时，
# 它与 app 一起被签。
#
# 用法：
#   bash scripts/build-sim-hid.sh            # 编译到 binaries/
#   bash scripts/build-sim-hid.sh --check    # 只检查是否已就绪（CI/启动时用）
set -uo pipefail
# pipefail 还不够：下面有两处 `cmd | sed`，而 `cmd` 的退出码会被 sed 掩盖。
# 本项目为此踩过一次（§3.29：`cargo test | tee log` 吞掉失败），所以这里
# 显式用 PIPESTATUS 取被管道第一个命令的真实状态，不依赖调用者的写法。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/crates/kcode-desktop/native/sim-hid.swift"
OUT_DIR="$ROOT/crates/kcode-desktop/binaries"
OUT="$OUT_DIR/kcode-sim-hid"

if [[ "${1:-}" == "--check" ]]; then
  if [[ -x "$OUT" ]]; then
    echo "✓ kcode-sim-hid 已就绪：$OUT"
    exit 0
  fi
  echo "· kcode-sim-hid 尚未编译（iOS 触摸输入将不可用）"
  exit 1
fi

# 非 macOS 直接跳过：这个 helper 只对 iOS 模拟器有意义，而模拟器只在 macOS 上。
# **必须以 0 退出**：打包脚本会调用它，而跨平台构建（或 CI 上的 Linux）不该因此失败。
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "· 非 macOS（$(uname -s)），跳过 kcode-sim-hid（iOS 模拟器只在 macOS 上存在）"
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "✗ 源码不存在：$SRC" >&2
  exit 2
fi

# swiftc 来自当前选中的开发者目录。取不到就明确报错，而不是让后续步骤
# 报一个「找不到 swiftc」——那与「Xcode 没装」是同一个原因，但更难读懂。
if ! command -v swiftc >/dev/null 2>&1; then
  DEV="$(/usr/bin/xcode-select -p 2>/dev/null || true)"
  if [[ -n "$DEV" && -x "$DEV/usr/bin/swiftc" ]]; then
    SWIFTC="$DEV/usr/bin/swiftc"
  else
    echo "✗ 找不到 swiftc（需要 Xcode 或 Command Line Tools）" >&2
    echo "  当前开发者目录：${DEV:-未取到}" >&2
    exit 2
  fi
else
  SWIFTC="swiftc"
fi

mkdir -p "$OUT_DIR"

# -O：注入是高频动作（拖动的每一步都要起一次进程），优化值得。
# 不加 -g：发布产物不需要调试符号，而它会显著增大体积。
echo "· 编译 kcode-sim-hid …"
"$SWIFTC" -O -o "$OUT" "$SRC" 2>&1 | sed 's/^/  /'
# PIPESTATUS[0] 是 swiftc 的退出码（不加这个会拿到 sed 的 0，编译失败也报成功）
if [[ "${PIPESTATUS[0]}" -ne 0 ]]; then
  echo "✗ 编译失败" >&2
  exit 1
fi

# 自检用的开发者目录：**不能直接用 `xcode-select -p`**。
#
# 实测：开发机的 `xcode-select -p` 常常指向 CommandLineTools（未跑过
# `xcode-select -s` 时就是默认值），而私有符号只在**完整 Xcode** 里。
# 直接用它会让自检永远失败——而 KCode 的探测逻辑本来就能找到别处的 Xcode
# （含外置卷），所以这里照同一顺序找一遍，找不到才退回 xcode-select。
#
# 扫描范围与 simulator.rs 的 app_roots() 保持一致：约定位置 +
# `/Volumes/*/` 下名字带 applications 的目录（含下一层）。
DEV_DIR="$(/usr/bin/xcode-select -p 2>/dev/null || true)"
find_xcode_dev() {
  local app
  for app in "/Applications/Xcode.app" "$HOME/Applications/Xcode.app"; do
    [[ -d "$app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework" ]] \
      && { echo "$app/Contents/Developer"; return 0; }
  done
  local dir
  while IFS= read -r dir; do
    for app in "$dir/Xcode.app" "$dir"/Xcode*.app; do
      [[ -d "$app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework" ]] \
        && { echo "$app/Contents/Developer"; return 0; }
    done
  done < <(find /Volumes -maxdepth 3 -type d -iname "*applications*" 2>/dev/null)
  return 1
}
if [[ ! -d "$DEV_DIR/Library/PrivateFrameworks/SimulatorKit.framework" ]]; then
  if found="$(find_xcode_dev)"; then
    DEV_DIR="$found"
  fi
fi

# 编译后自检：能跑起来并认出私有接口，才算真的可用。
# 这一步不可省——「编译通过」不代表「私有符号在这个 Xcode 里存在」。
if "$OUT" probe --developer-dir "$DEV_DIR" >/dev/null 2>&1; then
  printf '✓ 已编译并自检通过：%s（%s，Xcode 在 %s）\n' "$OUT" "$(du -h "$OUT" | cut -f1)" "$DEV_DIR"
else
  # 自检失败**不删除产物**：符号缺失可能只是因为当前没装完整 Xcode，
  # 而产物在装了 Xcode 的机器上仍然可用。如实告警即可。
  echo "⚠ 已编译，但 probe 自检未通过（$DEV_DIR 里可能没有所需私有符号）：" >&2
  "$OUT" probe --developer-dir "$DEV_DIR" 2>&1 | sed 's/^/  /' >&2
fi
