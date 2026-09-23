#!/usr/bin/env bash
# 检查平台门控造成的死代码 —— 这是 CI 在 Linux 上独有的失败类型。
#
# # 为什么需要（真实事故）
#
# `crates/kcode-desktop/src/lib.rs` 里有：
#
#   fn show_fatal_dialog(msg: &str) {
#       #[cfg(target_os = "macos")]
#       { ... applescript_quote(msg) ... }   // 只在这里被调用
#       #[cfg(target_os = "linux")]
#       { ... }
#   }
#
#   fn applescript_quote(s: &str) -> String { ... }   // ← 没有 cfg 门控
#
# 在 macOS 上编译：`applescript_quote` 有调用者，正常。
# 在 Linux 上编译：**它没有任何调用者** → `dead_code` 警告 →
# CI 的 `clippy --all-targets -- -D warnings` 把它变成错误。
#
# 这类问题**本地全绿**（开发机是 macOS），只在 CI 上暴露，而每轮 CI 约 5 分钟。
# 交叉编译能覆盖一部分（`cargo clippy --target x86_64-unknown-linux-gnu`），
# 但**依赖系统库的 crate 交叉不了**——`kcode-desktop` 需要 GTK/WebKit，
# 而它恰恰就是本轮出事的地方。所以需要一个不依赖编译器的静态检查。
#
# # 检查逻辑
#
# 对每个 `#[cfg(target_os = "X")] { ... }` **块**内的标识符，查找它们的定义；
# 若定义处没有相同方向的 cfg 门控、又在其它平台下无人调用，就是死代码。
#
# 实现上不做完整的语义分析（那需要编译器），而是用一条保守规则：
# **统计每个函数标识符的引用次数**——若某函数只在 `cfg(target_os = "X")`
# 块内被引用，而定义处未门控，则报出。
#
# ⚠️ 只把「`#[cfg(...)]` 后紧跟一行纯 `{`」视为块。
# `#[cfg]` 也能修饰**声明**（如 `#[cfg(target_os = "macos")] const BUNDLE_PATHS: ... =
# &[...];`），那不是块，把它当块会让后续所有代码被误判为「在块内」——
# 本脚本第一版就因此误报了 `pick` / `which_in`（它们其实在无门控的
# `detect()` 里被调用，Linux 上并非死代码）。误报比漏报更糟：它会训练人
# 忽略这个检查。
#
# 用法：bash scripts/check-platform-gating.sh
set -uo pipefail

# ⚠️ 变量展开统一用 ${}：中文紧跟变量名时多字节字节会并入变量名，
# 在 `set -u` 下报 unbound variable（本项目踩过三次）。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "════════ 平台门控检查 ════════"

FILES=$(find "$ROOT/crates" -name '*.rs' -type f 2>/dev/null)
if [[ -z "$FILES" ]]; then
  echo "✗ 未找到 Rust 源文件" >&2
  exit 2
fi

ERRORS=0
CHECKED=0

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  rel="${file#${ROOT}/}"

  # 逐个平台比较：某函数定义未门控、却只在某个平台块里被引用
  for os in macos linux; do
    # 取出该平台专属块内的所有函数调用式标识符（形如 name( ）
    BLOCK_IDS=$(awk -v os="$os" '
      # 看到 cfg 属性先挂起，等下一行决定它修饰的是「块」还是「声明」
      $0 ~ "#\\[cfg\\(target_os = \""os"\"\\)\\]" { pending=1; next }
      pending {
        line=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
        pending=0
        if (line == "{") { inblock=1; next }      # 块形态：从这里开始捕获
        next                                       # 声明形态：不是块，跳过本行
      }
      inblock {
        line=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
        if (line == "}") { inblock=0; next }       # 块结束
        print
      }
    ' "$file" | grep -oE '\b[a-z_][a-z0-9_]*\(' | tr -d '(' | sort -u)

    [[ -z "$BLOCK_IDS" ]] && continue

    for id in $BLOCK_IDS; do
      # 该标识符是否在本文件里有定义（fn name( 或 const name: 或 static name:）
      DEF_LINE=$(grep -nE "^[[:space:]]*(pub )?(fn|const|static) ${id}\b" "$file" | head -1 | cut -d: -f1)
      [[ -z "$DEF_LINE" ]] && continue   # 不是本文件的定义（或是方法/宏），跳过

      CHECKED=$((CHECKED + 1))

      # 定义处往上 5 行内是否有【同方向】的 cfg 门控
      DEF_START=$((DEF_LINE > 5 ? DEF_LINE - 5 : 1))
      if sed -n "${DEF_START},${DEF_LINE}p" "$file" | grep -qE "cfg\\(target_os = \"${os}\"\\)|cfg\\(not\\(target_os"; then
        continue   # 已门控，正确
      fi

      # 定义处未门控 → 看该标识符在**块外**是否还有引用
      OUTSIDE=$(awk -v os="$os" -v id="$id" '
        $0 ~ "#\\[cfg\\(target_os = \""os"\"\\)\\]" { pending=1; next }
        pending {
          line=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
          pending=0
          if (line == "{") { inblock=1; next }
          next
        }
        inblock {
          line=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
          if (line == "}") { inblock=0; next }
          next
        }
        !inblock && $0 ~ ("\\<" id "\\(") { print }
      ' "$file" | grep -vE "^[[:space:]]*(pub )?(fn|const|static) " | wc -l | tr -d ' ')

      if [[ "$OUTSIDE" -eq 0 ]]; then
        echo "  ✗ ${rel}:${DEF_LINE} \`${id}\` 只在 \`cfg(target_os = \"${os}\")\` 块内被引用，但定义处未门控" >&2
        echo "      → 在其它平台上它是死代码，会让 \`clippy -D warnings\` 失败" >&2
        echo "      → 修法：给定义加同款 \`#[cfg(target_os = \"${os}\")]\`" >&2
        ERRORS=$((ERRORS + 1))
      fi
    done
  done
done <<< "$FILES"

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "✗ 发现 ${ERRORS} 处平台门控缺陷（共检查 ${CHECKED} 个候选）" >&2
  echo "  这类问题本地（macOS）全绿、只在 CI 的 Linux job 上暴露。" >&2
  exit 1
fi
echo "  ✓ 未发现「定义未门控但只在平台块内被引用」的情况（检查 ${CHECKED} 个候选）"
echo "✓ 平台门控检查通过"
