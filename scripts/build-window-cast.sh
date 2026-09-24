#!/usr/bin/env bash
# 编译「窗口帧源」helper（kcode-window-cast）。
#
# # 它解决什么
#
# 三个平台的模拟器画面原本都是「每帧起一个子进程截图」：
#
#   simctl io screenshot      118ms/帧  → 约 8 fps
#   adb exec-out screencap    350ms/帧  → 约 3 fps
#
# 而实测 `simctl list devices`（**纯查询、根本不截图**）就要 116ms —— 也就是说
# 时间几乎全花在「每次重新初始化」上，与截图本身无关（截图只占约 2ms）。
#
# 本 helper 改用 ScreenCaptureKit 的**常驻流**：抓一次窗口，之后由系统持续
# 推帧（被捕获的进程零感知）。实测 **29.5fps，编码 7.3ms**。
#
# # 为什么用窗口捕获而不是私有帧回调
#
# 1. **全公开 API**（ScreenCaptureKit 自 macOS 12.3 起公开），不需要 dlopen
#    私有框架、不依赖 Xcode 内部符号；
# 2. **三平台通用**：iOS 模拟器窗口、Android 模拟器窗口、微信开发者工具窗口
#    都是普通窗口，一条通道全解决；
# 3. 私有帧回调那条路实测**没打通**（见 sim-cast.swift 与勘误 §3.42）。
#
# 代价：需要「屏幕录制」权限（首次运行系统会弹窗）。这是必然的——
# 窗口捕获在 macOS 上就是受这个权限管辖。
#
# # 签名
#
# 与 sim-hid 同样由 swiftc 自动产出 adhoc 签名，无需额外步骤。
#
# 用法：
#   bash scripts/build-window-cast.sh            # 编译到 binaries/
#   bash scripts/build-window-cast.sh --check    # 只检查是否已就绪
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/crates/kcode-desktop/native/window-cast.swift"
OUT_DIR="$ROOT/crates/kcode-desktop/binaries"
OUT="$OUT_DIR/kcode-window-cast"

if [[ "${1:-}" == "--check" ]]; then
  if [[ -x "$OUT" ]]; then
    echo "✓ kcode-window-cast 已就绪：$OUT"
    exit 0
  fi
  echo "· kcode-window-cast 尚未编译（iOS/Android 画面将退回逐帧截图，约 8fps / 3fps）"
  exit 1
fi

# 非 macOS 跳过：ScreenCaptureKit 是 macOS 专有；Linux/Windows 上各平台
# 有自己的捕获路径（尚未实现），退回逐帧截图仍可用。
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "· 非 macOS（$(uname -s)），跳过 kcode-window-cast"
  exit 0
fi

# ScreenCaptureKit 需要 macOS 12.3+。低版本上**明确跳过**而不是编译失败
# （编译失败会让打包中止，而这是可选能力）。
SW_V=$(sw_vers -productVersion 2>/dev/null || echo "0")
MAJOR=${SW_V%%.*}
if [[ "${MAJOR:-0}" -lt 12 ]]; then
  echo "· macOS $SW_V 低于 12.3，ScreenCaptureKit 不可用，跳过（画面退回逐帧截图）"
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "✗ 源码不存在：$SRC" >&2
  exit 2
fi

if ! command -v swiftc >/dev/null 2>&1; then
  DEV="$(/usr/bin/xcode-select -p 2>/dev/null || true)"
  if [[ -n "$DEV" && -x "$DEV/usr/bin/swiftc" ]]; then
    SWIFTC="$DEV/usr/bin/swiftc"
  else
    echo "✗ 找不到 swiftc（需要 Xcode 或 Command Line Tools）" >&2
    exit 2
  fi
else
  SWIFTC="swiftc"
fi

mkdir -p "$OUT_DIR"
echo "· 编译 kcode-window-cast …"
"$SWIFTC" -O -o "$OUT" "$SRC" 2>&1 | sed 's/^/  /'
# PIPESTATUS[0] 取 swiftc 的真实退出码（`cmd | sed` 会让它变成 sed 的，本项目踩过）
if [[ "${PIPESTATUS[0]}" -ne 0 ]]; then
  echo "✗ 编译失败" >&2
  exit 1
fi

printf '✓ 已编译：%s（%s）\n' "$OUT" "$(du -h "$OUT" | cut -f1)"
echo "  注意：首次使用时系统会请求「屏幕录制」权限，需要你在系统设置里勾选一次。"
