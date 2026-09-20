#!/usr/bin/env bash
# 校验「窗口绘制区」与「窗口尺寸」是否一致。
#
# # 为什么需要这个检查
#
# macOS 下出现过窗口尺寸已变但 WebView 只绘制到旧尺寸的现象：
# 右侧与底部露出未绘制的窗口底色（浅色系统上表现为白块）。
# 这类问题**所有单元测试都测不到**——它只存在于真实窗口的合成层。
#
# 做法：取窗口的逻辑尺寸，截图后在该区域内扫描非背景像素的范围，
# 比较两者。容忍 2px 的边框与抗锯齿误差。
#
# 用法：bash scripts/verify-window-fit.sh <PID> [截图输出路径]
set -uo pipefail

PID="${1:-}"
if [[ -z "$PID" ]]; then
  # 自动找一个正在运行的实例
  PID="$(pgrep -f 'kcode-desktop' | head -1 || true)"
fi
if [[ -z "$PID" ]]; then
  cat >&2 <<'EOF'
✗ 未找到正在运行的 kcode-desktop 进程。

用法：bash scripts/verify-window-fit.sh <PID>
先启动应用，再用本脚本检查。

说明：本检查需要真实窗口，无法在无头环境运行。
EOF
  exit 3
fi

SHOT="${2:-/tmp/kcode-window-fit.png}"

# 用 CoreGraphics 枚举窗口而非 AppleScript：
# macOS 的自动标签页会把窗口合并进标签栏，
# AppleScript 的 `window 1` 可能取不到正确的那个。
HELPER="$(mktemp -d)/winlist"
cat > "$HELPER.swift" <<'SWIFT'
import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { exit(1) }
for w in list {
    guard let owner = w[kCGWindowOwnerPID as String] as? Int, owner == pid else { continue }
    guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
    let b = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    // 输出：x y w h
    print("\(Int(b["X"] ?? 0)) \(Int(b["Y"] ?? 0)) \(Int(b["Width"] ?? 0)) \(Int(b["Height"] ?? 0))")
    exit(0)
}
exit(2)
SWIFT
swiftc -O "$HELPER.swift" -o "$HELPER" 2>/dev/null
read -r WX WY WW WH <<< "$("$HELPER" "$PID" || true)"
rm -rf "$(dirname "$HELPER")"

if [[ -z "${WW:-}" ]]; then
  if ! ps -p "$PID" >/dev/null 2>&1; then
    echo "✗ 进程 $PID 不存在" >&2
  else
    echo "✗ 进程 $PID 存活但**没有任何可见窗口**" >&2
    echo "  常见原因：窗口配置里的 visible=false，而未配套调用 show()" >&2
    echo "  （会导致应用启动了却什么都不显示）" >&2
  fi
  exit 2
fi

sleep 0.4
screencapture -x "$SHOT"

python3 - "$SHOT" "$WX" "$WY" "$WW" "$WH" <<'PY'
import sys
from PIL import Image

shot, wx, wy, ww, wh = sys.argv[1], *map(int, sys.argv[2:6])
im = Image.open(shot).convert('RGB')
S = 2 if im.width >= 3000 else 1          # Retina 判定
px = im.load()
x0, y0 = wx * S, wy * S
x1 = min((wx + ww) * S, im.width)
y1 = min((wy + wh) * S, im.height)

minx = miny = None
maxx = maxy = None
for y in range(y0, y1, 2):
    for x in range(x0, x1, 2):
        r, g, b = px[x, y]
        # 未绘制区域显示的是**窗口背景色**（我们用 set_background_color
        # 设成 #06070a）。早先只判「纯白」是错的——深色背景下未绘制区域
        # 也是深色，会被误判为「已绘制」而让检查假通过。
        # 这里改为：与窗口背景色接近的像素视为**未绘制**。
        if abs(r - 6) <= 6 and abs(g - 7) <= 6 and abs(b - 10) <= 6:
            continue
        if minx is None or x < minx: minx = x
        if maxx is None or x > maxx: maxx = x
        if miny is None or y < miny: miny = y
        if maxy is None or y > maxy: maxy = y

print(f'窗口逻辑尺寸: {ww} x {wh}  @ ({wx},{wy})')

if minx is None:
    print('✗ 窗口区域全为白色 —— 完全未绘制')
    sys.exit(1)

drawn_w = (maxx - minx) // S
drawn_h = (maxy - miny) // S
right_gap = ((x1 - maxx) // S)
bottom_gap = ((y1 - maxy) // S)

print(f'实际绘制区:   {drawn_w} x {drawn_h}')
print(f'右侧未绘制:   {right_gap} px')
print(f'底部未绘制:   {bottom_gap} px')

TOL = 4
fail = False
if right_gap > TOL:
    print(f'✗ 右侧有 {right_gap}px 未绘制（窗口尺寸与绘制区不一致）')
    fail = True
if bottom_gap > TOL:
    print(f'✗ 底部有 {bottom_gap}px 未绘制')
    fail = True

if fail:
    print()
    print('可能原因：')
    print('  · 窗口尺寸变化后 WebView 未同步（resize 未传播到渲染进程）')
    print('  · 窗口显示时机早于前端首次布局完成')
    sys.exit(1)

print('✓ 绘制区与窗口尺寸一致')
PY
