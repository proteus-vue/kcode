#!/usr/bin/env bash
# 从 cargo test 日志里抽出可行动的失败信息，以 GitHub 注解的形式输出。
#
# # 为什么需要
#
# CI 的完整日志需要仓库 admin 权限才能下载（本项目是公开仓库、开发机没有
# admin），而**注解面板匿名可读**。于是没有这个脚本时，rust job 失败只能看到
# 「某步骤失败」，不知道是哪个用例、哪一行断言——定位必须再跑一轮，
# 失败报告因此不可行动。
#
# 这与勘误 §3.23 是同一类问题：报告本身要被审计。「测试失败了」不是结论，
# 「哪个用例、期望什么、实际什么」才是。
#
# # 用法
#
#   bash scripts/ci-summarize-failures.sh /tmp/rust-integration.log
#
# 在本地也可用：跑测试时 `| tee log`，失败时用它看摘要。
#
# 输出形式：
# - 有 FAILED 用例 → 逐条 `::error::test <名字> ... FAILED`，附该用例的恐慌信息
# - 无 FAILED 行 → 先判性质（编译错误 / 构建脚本失败 / 资源打断），
#   再给根因（构建脚本失败时取 Caused by 段），决定性的行排最前（调用方会 head 截断）
set -uo pipefail

LOG="${1:-}"
if [[ -z "$LOG" || ! -f "$LOG" ]]; then
  echo "::error::找不到日志文件：${LOG:-（未提供）}"
  exit 0
fi

# ── 先剥掉 ANSI 颜色码（这一步是**根因级**的，不是美化）─────────────────
#
# 2026-09-24 之前，rust job 连续多轮报「日志停在编译行、没有任何 error 行」，
# 据此一路推断成「资源打断/OOM」。**真相是错误就在日志里，被颜色码埋了**：
#
#   [1m[91merror[0m: failed to run custom build command for `kcode-desktop`
#
# `^error` 当然匹配不上 `\x1b[1m\x1b[91merror...`——于是**所有**按错误格式写的
# 判据（`^error`、`^error\[`、`error\[E[0-9]+\]`）全部落空，最后只剩
# 「没有 error 行」这个结论。同一个原因也解释了为什么 tail -12 看不到它：
# 它不在尾部，在中部，而**中部的行只有在能匹配上时才会被打出来**。
#
# 本机（macOS）复现同一处失败时输出不带颜色（cargo 判 stderr 不是 TTY），
# 所以这个差异**只在 CI 上出现**——正是「本地全绿、CI 常红」的成因之一。
#
# 因此：一律在剥色后的副本上做匹配。sed 的 \x1b 用 bash 的 $'\e' 表达
# （BSD/GNU sed 对 \x1b 的支持不一致，用 $'\e' 最稳）。
SANITIZED="$(mktemp -t kcode-log.XXXXXX)"
trap 'rm -f "$SANITIZED"' EXIT
sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$LOG" > "$SANITIZED"
LOG="$SANITIZED"

failed=$(grep -E '^test .+ \.\.\. FAILED' "$LOG" || true)

if [[ -n "$failed" ]]; then
  while IFS= read -r line; do
    echo "::error::$line"
  done <<<"$failed"

  # 逐个失败用例附上它的恐慌信息：只有用例名仍然不知道「为什么」
  while IFS= read -r name; do
    # 从 `---- <name> stdout ----` 段里取到下一个分节为止
    awk -v pat="$name" '
      $0 ~ "^---- " pat " stdout ----" { hit=1; next }
      hit && /^---- / { exit }
      hit && /^test result:/ { exit }
      hit && NF { print }
    ' "$LOG" | head -12 | while IFS= read -r detail; do
      echo "::error::  $detail"
    done
  done < <(sed -E 's/^test (.+) \.\.\. FAILED$/\1/' <<<"$failed")
  exit 0
fi

# 没有 FAILED 行：多半是编译失败、**构建脚本失败**、资源耗尽，或进程被打断。
#
# # 为什么要先说「日志是不是停在编译中途」
#
# 这几种原因的处置方式完全不同，而它们的日志形态可区分：
#
# - **代码错误**：日志里有 `error[E...]` / `error: could not compile`；
# - **构建脚本失败**：`failed to run custom build command for <crate>`，
#   真正的根因在它下面的 `Caused by:` / 构建脚本输出里；
# - **资源/超时打断**：日志**停在 `Compiling ...` 行**，没有任何 error 行
#   （rustc 还没跑完，进程就没了）。
#
# 第二类一度只能靠人反复对照几轮日志才能察觉（见 §3.28：连续多轮失败，
# 每轮拿到的注解都被配额截断）。所以这里直接把判据打出来，
# 让「下一步该修代码还是修环境」当场可判，不必再猜一轮。
#
# # 输出的排序规则：**决定性 → 参考性**
#
# 调用方会用 `head -N` 截断（注解有配额，实测 23 条/check-run），所以
# 「哪几行先出现」直接决定「哪几行能送达」。**根因必须排第一**——
# 2026-09-24 那轮就是反例：根因在输出的第 10 行左右，被 `head -8` 截掉，
# 于是又白跑一轮。所以下面按「判据 → 根因 → 细节 → 尾部」排列。
echo "::error::未找到失败用例行——下面是判据、根因与尾部："

# ① 判据（一行定性：该修代码、该修构建脚本、还是该查环境）
if grep -q "failed to run custom build command" "$LOG"; then
  echo "::error::判据：**构建脚本失败**（不是 rustc 编译错误，也不是资源问题）"
elif grep -qE "^\s*error" "$LOG"; then
  echo "::error::判据：编译/代码错误（日志里有 error 行，见下）"
elif grep -qE "^\s*(Compiling|Building|Checking) " "$LOG"; then
  echo "::error::判据：日志停在编译中途且无 error 行 → 倾向**资源/超时打断**（对照本步骤上面那条「资源」注解）"
else
  echo "::error::判据：形态未知，见下方日志尾部"
fi

# ② 根因。构建脚本失败时，`Caused by` 段里那几行才是原因。
#    这里刻意取**最后几行**：构建脚本输出末尾通常就是它自己报的错
#    （例如 `resource path 'binaries' doesn't exist`）。
if grep -q "failed to run custom build command" "$LOG"; then
  awk '/failed to run custom build command/{f=1} f{print; n++} n>40{exit}' "$LOG" \
    | grep -vE "^\s*$" | tail -4 | while IFS= read -r l; do
    echo "::error::根因：$l"
  done
fi

# ③ 参考：日志规模（进程被打断时，缓冲区输出会一起丢，日志会「干净地」
#    停在中途——此时「真没有错误」与「错误丢了」只能靠规模区分）
echo "::error::日志规模：$(wc -l < "$LOG") 行 / $(wc -c < "$LOG") 字节"

# ④ 参考：错误行本身（`^\s*` 是必需的——rustc 会缩进，见下方注释）
grep -nE "^\s*(error|warning: unused|thread .* panicked)" "$LOG" | head -4 | while IFS= read -r line; do
  echo "::error::  $line"
done

# ⑤ 参考：任何位置的错误特征串
grep -nE "error\[E[0-9]+\]|No space left|Killed|out of memory|signal: 9" "$LOG" | head -3 | while IFS= read -r line; do
  echo "::error::  线索：$line"
done

# ⑥ 兜底：严格匹配全空时的宽松匹配。上面几条都建立在「失败信息按规范格式
#    打出来」这个假设上；宽松匹配会命中无关词，故只在前者全空时启用。
if ! grep -qE "^\s*error|error\[E[0-9]+\]|No space left|Killed|out of memory|signal: 9" "$LOG"; then
  grep -inE "error|killed|abort|no space|out of memory|signal" "$LOG" | tail -2 | while IFS= read -r line; do
    echo "::error::  宽松匹配（仅供参考）：$line"
  done
fi

echo "::error::---- 日志尾部（最后 12 行）----"
tail -12 "$LOG" | while IFS= read -r line; do
  [[ -n "$line" ]] && echo "::error::  $line"
done
echo "::error::（完整日志见 artifact rust-test-logs；注解有配额，只有这些行能送达）"
exit 0
