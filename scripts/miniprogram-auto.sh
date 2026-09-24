#!/usr/bin/env bash
# 启动微信开发者工具的小程序自动化服务（本应用的面板也会自动做，这里是手动入口）。
#
# # 这个脚本做什么
#
# 调 `cli auto` 让开发者工具进入自动化模式，监听固定端口 9420。
# 之后本应用的模拟器面板就能取画面、点元素了。
#
# # 为什么需要手动入口
#
# 面板会自动启动（用户点「重新检测」时）。但自动化模式会给 IDE 带来状态变化，
# 有人希望自己控制时机——尤其在排查「为什么连不上」时，手动跑一次能看到
# `cli auto` 的原始输出，而面板只给一句概括的失败原因。
#
# # 前置条件（缺一不可，脚本会逐条自检）
#
# 1. 微信开发者工具**已安装**（自动发现，也可用 MP_TOOL 指定）；
# 2. 开发者工具里**已打开目标项目**（脚本从工具日志推断，或用 MP_PROJECT 指定）；
# 3. 已在「设置 → 安全设置」里**开启服务端口**（这一步必须人工做，
#    对应 IDE 上的 HTTP 端口 23843；脚本只能检测它是否开着）。
#
# 用法：
#   bash scripts/miniprogram-auto.sh                 # 自动发现工具与项目
#   bash scripts/miniprogram-auto.sh --port 9500     # 换一个自动化端口
#   MP_PROJECT=/path/to/project bash scripts/miniprogram-auto.sh
set -uo pipefail

PORT="${MP_AUTO_PORT:-9420}"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --help|-h) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
ARGS+=("$PORT")

echo "════════ 小程序自动化 ════════"

# ── ① 工具 ────────────────────────────────────────────────────────────
TOOL="${MP_TOOL:-}"
if [[ -z "$TOOL" ]]; then
  # 与后端的发现逻辑保持一致：约定位置 → 外置卷上的 applications 目录
  for c in "/Applications/wechatwebdevtools.app" "/Applications/微信开发者工具.app" \
           "$HOME/Applications/wechatwebdevtools.app"; do
    [[ -d "$c" ]] && { TOOL="$c"; break; }
  done
fi
if [[ -z "$TOOL" ]]; then
  # 扫 /Volumes/*/ 与下一层里名字带 applications 的目录（后端同样这么做）
  while IFS= read -r d; do
    for name in wechatwebdevtools.app 微信开发者工具.app; do
      [[ -d "$d/$name" ]] && { TOOL="$d/$name"; break 2; }
    done
  done < <(find /Volumes -maxdepth 3 -type d -iname "*applications*" 2>/dev/null)
fi
if [[ -z "$TOOL" ]]; then
  echo "✗ 未找到微信开发者工具" >&2
  echo "  可用 MP_TOOL=/path/to/wechatwebdevtools.app 指定。" >&2
  exit 2
fi
CLI="$TOOL/Contents/MacOS/cli"
[[ -x "$CLI" ]] || { echo "✗ 该 app 里没有 cli：$CLI" >&2; exit 2; }
echo "✓ 工具：$TOOL"

# ── ② 服务端口（IDE 侧，必须人工开启）─────────────────────────────────
#
# ⚠️ **必须探测运行中进程实际监听的端口，不能只读记录文件**。
#
# 实测踩了两次（两种不同的错法）：
#
#  1. 按目录顺序取 `.cli` 里的端口 → 取到**没在运行的那份副本**的端口
#     （本机装了两份开发者工具，各有一份用户数据目录）；
#  2. 就算改成「优先取在监听的」，记录文件也是**懒更新**的——工具重启后
#     新端口还没写回文件（实测记录里是 3799/51928，而真实端口是 23843）。
#
# 根因是同一个：**记录文件是缓存，不是事实**。事实是「哪个端口在监听」。
# 所以直接扫运行中进程的监听端口，再用 HTTP 特征确认是开发者工具。
RUNNING_APP=""
for pid in $(pgrep -f "wechatwebdevtools.app/Contents/MacOS/Electron" 2>/dev/null); do
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
  case "$cmd" in
    *wechatwebdevtools.app/*) RUNNING_APP="${cmd%%/Contents/MacOS/*}"; break ;;
  esac
done
if [[ -z "$RUNNING_APP" ]]; then
  echo "✗ 微信开发者工具没有在运行" >&2
  echo "  请先打开它并打开目标项目。" >&2
  exit 2
fi
echo "✓ 运行中的实例：$RUNNING_APP"

# 扫该实例的监听端口，认「HTTP 服务」特征。
# 不认 TCP 可连就够了：Electron 自己开了一堆监听端口（实测 49152/5000/56941…），
# 只有 IDE 的 HTTP 服务会对未知路径回 404（而不是拒绝或超时）。
IDE_PORT=""
PIDS="$(pgrep -f "wechatwebdevtools.app" 2>/dev/null | tr '\n' ',')"
while IFS= read -r port; do
  [[ -z "$port" ]] && continue
  code="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || echo "")"
  if [[ "$code" == "404" || "$code" == "200" ]]; then
    IDE_PORT="$port"
    break
  fi
done < <(lsof -nP -p "${PIDS%,}" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' \
         | grep -oE '[0-9]+$' | sort -u)

if [[ -z "$IDE_PORT" ]]; then
  echo "✗ 未找到开发者工具的 HTTP 服务端口" >&2
  echo "  请在「设置 → 安全设置」里开启「服务端口」，然后重跑本脚本。" >&2
  echo "  （也请确认工具里已打开目标项目）" >&2
  exit 2
fi
echo "✓ IDE 服务端口：$IDE_PORT"

# ── ③ 项目 ────────────────────────────────────────────────────────────
PROJECT="${MP_PROJECT:-}"
if [[ -z "$PROJECT" ]]; then
  # 从工具日志尾部推断：找第一个含 project.config.json 的目录。
  # 日志格式随版本可能变，所以这只是便利——失败时让人显式指定。
  LATEST_LOG="$(ls -t "$HOME/Library/Application Support/微信开发者工具"/*/WeappLog/*.log 2>/dev/null | head -1)"
  if [[ -n "$LATEST_LOG" ]]; then
    while IFS= read -r cand; do
      d="$cand"
      for _ in 1 2 3 4 5 6; do
        if [[ -f "$d/project.config.json" ]]; then PROJECT="$d"; break 2; fi
        d="$(dirname "$d")"
        [[ "$d" == "/" || "$d" == "." ]] && break
      done
    done < <(grep -oE '/[A-Za-z0-9_./\u4e00-\u9fa5-]+' "$LATEST_LOG" 2>/dev/null | sort -u | head -400)
  fi
fi
if [[ -z "$PROJECT" || ! -f "$PROJECT/project.config.json" ]]; then
  echo "✗ 未确定小程序项目目录" >&2
  echo "  请在开发者工具里打开目标项目，或用 MP_PROJECT=/path/to/project 指定。" >&2
  exit 2
fi
echo "✓ 项目：$PROJECT"

# ── ④ 启动自动化 ──────────────────────────────────────────────────────
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "✓ 自动化服务已在端口 $PORT 上运行（无需重启）"
  exit 0
fi

echo "· 启动自动化（端口 $PORT）…"
# 超时给足：IDE 要先编译项目，实测数秒到十几秒
if ! timeout 60 "$CLI" auto --project "$PROJECT" --auto-port "$PORT" --trust-project; then
  echo "✗ 启动失败。常见原因：" >&2
  echo "  · 开发者工具里没打开这个项目" >&2
  echo "  · 服务端口（安全设置）没开" >&2
  echo "  · 端口 $PORT 被别的程序占用" >&2
  exit 1
fi

# 就绪判定：能建 TCP 连接即算就绪（不假设它有 HTTP 接口——实测 HTTP 一律 404）
for _ in $(seq 1 20); do
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "✓ 自动化服务就绪：ws://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.5
done
echo "✗ 启动命令成功但端口 $PORT 未在监听" >&2
exit 1
