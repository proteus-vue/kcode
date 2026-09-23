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

# 没有 FAILED 行：多半是编译失败或环境缺失（二进制找不到、npm ci 没装全）
echo "::error::未找到失败用例行——可能是编译失败或环境问题，下面是日志中的错误与尾部："
grep -nE "^(error|warning: unused|thread .* panicked)" "$LOG" | head -20 | while IFS= read -r line; do
  echo "::error::  $line"
done
echo "::error::---- 日志尾部 ----"
tail -30 "$LOG" | while IFS= read -r line; do
  [[ -n "$line" ]] && echo "::error::  $line"
done
exit 0
