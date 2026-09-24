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
# - 无 FAILED 行（编译失败/环境问题）→ 输出日志里的 error[..] 与尾部内容
set -uo pipefail

LOG="${1:-}"
if [[ -z "$LOG" || ! -f "$LOG" ]]; then
  echo "::error::找不到日志文件：${LOG:-（未提供）}"
  exit 0
fi

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

# 没有 FAILED 行：多半是编译失败、资源耗尽，或进程被环境打断。
#
# # 为什么要先说「日志是不是停在编译中途」
#
# 这三种原因的处置方式完全不同，而它们的日志形态可区分：
#
# - **代码错误**：日志里有 `error[E...]` / `error: could not compile`；
# - **资源/超时打断**：日志**停在 `Compiling ...` 行**，没有任何 error 行
#   （rustc 还没跑完，进程就没了）。
#
# 第二类一度只能靠人反复对照几轮日志才能察觉（见 §3.28：连续多轮失败，
# 每轮拿到的注解都被配额截断）。所以这里直接把判据打出来，
# 让「下一步该修代码还是查环境」当场可判，不必再猜一轮。
echo "::error::未找到失败用例行——可能是编译失败或环境问题，下面是日志中的错误与尾部："

# 日志规模本身就是判据。进程被 SIGKILL 打断时，**缓冲区里的输出会一起丢**，
# 于是日志会「干净地」停在中途：没有 error 行、没有 FAILED 行，只剩一个
# 非零退出码（本项目遇到的正是 exit 101 + 零 error 行）。这种情况下，
# 「输出丢了」与「真的没有错误」只能靠规模区分——正常编译一份 tauri 依赖树
# 远不止几十 KB（§3.31）。
echo "::error::  日志规模：$(wc -l < "$LOG") 行 / $(wc -c < "$LOG") 字节"

if grep -qE "^\s*(Compiling|Building|Checking) " "$LOG" && ! grep -qE "^\s*error" "$LOG"; then
  last=$(grep -vE "^\s*$" "$LOG" | tail -1)
  echo "::error::⇒ 判据：日志停在编译中途，且无任何 error 行 → 倾向**资源/超时打断**，而非代码错误"
  echo "::error::  日志最后一行：${last}"
  echo "::error::  内存/磁盘数字见本步骤上面那条「资源」注解（基线 + 失败现场）"
fi

# 行首的 `^error` 会漏掉**缩进**的错误行（rustc 的 `  error[E0433]: ...` 常带
# 前导空格，本项目自己造样例日志时就因此误判成「无 error 行 ⇒ 资源问题」）。
# 一律用 `^\s*error`。
grep -nE "^\s*(error|warning: unused|thread .* panicked)" "$LOG" | head -12 | while IFS= read -r line; do
  echo "::error::  $line"
done

# 任何位置出现 error（不只行首）：编译器的错误有时带前缀（如 `  error[E0433]`）
grep -nE "error\[E[0-9]+\]|No space left|Killed|out of memory|signal: 9" "$LOG" | head -6 | while IFS= read -r line; do
  echo "::error::  线索：$line"
done

# 严格匹配全部落空时的**宽松兜底**。上面几条都建立在「失败信息是编译器按
# 规范格式打出来的」这个假设上，而「exit 101 + 零 error 行」的现场恰恰说明
# 该假设可能不成立。宽松匹配会命中无关词（标识符、测试名、告警文案），
# 所以只在严格匹配全空时启用，且只取**尾部 3 行**——尾部最接近失败现场。
if ! grep -qE "^\s*error|error\[E[0-9]+\]|No space left|Killed|out of memory|signal: 9" "$LOG"; then
  grep -inE "error|killed|abort|no space|out of memory|signal" "$LOG" | tail -3 | while IFS= read -r line; do
    echo "::error::  宽松匹配（仅供参考）：$line"
  done
fi

echo "::error::---- 日志尾部（最后 12 行）----"
tail -12 "$LOG" | while IFS= read -r line; do
  [[ -n "$line" ]] && echo "::error::  $line"
done
echo "::error::（完整日志见 artifact rust-test-logs；注解有配额，只有这些行能送达）"
exit 0
