#!/usr/bin/env bash
# 校验 Tauri 2 capability 配置存在且包含必需权限。
#
# # 为什么需要这个检查
#
# Tauri 2 默认**不授予任何权限**。若缺少 capability 声明：
#
#   - 构建**仍然成功**（不会有任何编译错误）
#   - `invoke` 与 `listen` 在运行时被静默拒绝
#   - 表现：后端确实完成了工作（进程起了、线程建了、日志有记录），
#     但前端界面完全不知道——侧栏空白、按钮无响应、错误区没有提示
#
# 这类缺陷能穿过全部 Rust 单测与集成测试，因为那些测试直接调用 Rust API，
# 从不经过 IPC 层。本检查补上这一层。
#
# 用法：bash scripts/verify-tauri-capabilities.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAP_DIR="$ROOT/crates/kcode-desktop/capabilities"

echo "════════ Tauri capability 校验 ════════"

if [[ ! -d "$CAP_DIR" ]]; then
  echo "✗ 缺少 capabilities 目录：$CAP_DIR" >&2
  echo "  Tauri 2 需要显式声明权限，否则 invoke/listen 会被静默拒绝。" >&2
  exit 1
fi

# 兼容 bash 3.2（macOS 自带）：不用 mapfile
FILES=""
COUNT=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  FILES="$FILES$f"$'\n'
  COUNT=$((COUNT + 1))
done < <(find "$CAP_DIR" -name '*.json' 2>/dev/null)

if [[ $COUNT -eq 0 ]]; then
  echo "✗ capabilities 目录下没有 JSON 文件" >&2
  exit 1
fi

echo "发现 $COUNT 个 capability 文件"
FAIL=0

# 必需权限：事件监听是前端接收领域事件的唯一通道
REQUIRED=("core:default" "core:event:default")
# 建议包含（缺失会导致 listen 失败）
ADVISED=("core:event:allow-listen")

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  echo
  echo "── $(basename "$f") ──"
  # 用 python 解析（jq 不一定安装）
  OUT="$(python3 - "$f" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"PARSE_ERROR:{e}")
    sys.exit(0)
perms = d.get("permissions", [])
# permissions 元素可能是字符串或对象
flat = []
for p in perms:
    if isinstance(p, str):
        flat.append(p)
    elif isinstance(p, dict):
        flat.append(p.get("identifier", ""))
print("IDENTIFIER:" + str(d.get("identifier", "(无)")))
print("WINDOWS:" + str(d.get("windows", [])))
print("WEBVIEWS:" + str(d.get("webviews", [])))
print("PERMS:" + ",".join(flat))
PY
)"
  if grep -q '^PARSE_ERROR' <<< "$OUT"; then
    echo "✗ JSON 解析失败"
    FAIL=1
    continue
  fi
  echo "  $(grep '^IDENTIFIER:' <<< "$OUT" | cut -d: -f2-)"
  echo "  windows: $(grep '^WINDOWS:' <<< "$OUT" | cut -d: -f2-)"
  echo "  webviews: $(grep '^WEBVIEWS:' <<< "$OUT" | cut -d: -f2-)"
  PERMS="$(grep '^PERMS:' <<< "$OUT" | cut -d: -f2-)"
  echo "  permissions: $PERMS"

  for need in "${REQUIRED[@]}"; do
    if grep -q "$need" <<< "$PERMS"; then
      echo "  ✓ 含 ${need}"
    else
      echo "  ✗ 缺少必需权限：$need" >&2
      FAIL=1
    fi
  done
  for adv in "${ADVISED[@]}"; do
    if grep -q "$adv" <<< "$PERMS"; then
      echo "  ✓ 含 ${adv}"
    else
      echo "  ⚠ 建议添加：${adv}（缺失可能导致 listen 失败）"
    fi
  done

  # 目标字段必须非空，否则 capability 不生效于任何 webview
  WEBVIEWS="$(grep '^WEBVIEWS:' <<< "$OUT" | cut -d: -f2-)"
  if grep -q '^WINDOWS:\[\]' <<< "$OUT" && grep -q '^WEBVIEWS:\[\]' <<< "$OUT"; then
    echo "  ✗ windows 与 webviews 都为空 —— 该 capability 不作用于任何 webview" >&2
    FAIL=1
  fi

  # ── 安全：不得用 windows 授权 ──────────────────────────────────────
  #
  # 右侧栏的内嵌浏览器是**同一窗口下的另一个 webview**，加载的是任意外部
  # 网页。而 Tauri 的匹配逻辑是 `webviews.any(..) || windows.any(..)`
  # （见 tauri/src/ipc/authority.rs:459）：用 windows 匹配会把权限一并授予
  # 该窗口下的所有 webview——等于让互联网上的任意站点调用 exec_start
  # （执行命令）与 read_file_detail（读工作区文件）。
  #
  # 必须用 webviews 精确指定应用自己的那个。
  if ! grep -q '^WINDOWS:\[\]' <<< "$OUT"; then
    echo "  ✗ 该 capability 使用了 windows 匹配 —— 会把权限授予内嵌浏览器里的任意网页。" >&2
    echo "    请改用 \"webviews\": [\"main\"]。" >&2
    FAIL=1
  fi
  if grep -q '^WEBVIEWS:\[\]' <<< "$OUT"; then
    echo "  ✗ webviews 为空 —— 应用自身将拿不到权限（invoke 会被静默拒绝）" >&2
    FAIL=1
  fi
done <<< "$FILES"

echo
if [[ $FAIL -eq 0 ]]; then
  echo "✓ capability 配置有效"
else
  echo "✗ capability 配置有问题（见上）" >&2
fi
exit $FAIL
