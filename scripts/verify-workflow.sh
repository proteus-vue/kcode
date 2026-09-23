#!/usr/bin/env bash
# CI 自身的有效性校验。
#
# # 为什么需要这个脚本
#
# workflow 文件**无效**时，GitHub 的行为是：创建一次 run，但**一个 job 都不跑**，
# 立刻判失败。它既不会在某个步骤里报错（没有步骤被执行），也不会出现在
# check 列表里让人一眼看见——在网页上它只是一条很快过去的红叉。
#
# 本项目的实际后果：`.github/workflows/protocol-contract.yml` 里写了
# `if: ${{ secrets.KCODE_MODEL_API_KEY != '' }}`，而 **`secrets` 上下文
# 不允许出现在 `if:` 表达式里**。这一处表达式让**整个文件**失效，
# 于是连续 18 次推送、涵盖协议契约/单元测试/前端/漂移检查在内的三道闸门
# **一次都没有执行过**，而 README 却长期宣称「协议行为由 CI 持续验证」。
# 直到有人去查 run 的 job 列表（0 个 job）才暴露。详见
# `docs/协议勘误与修正.md` §3.25。
#
# 失败模式的特征是「静默」：没有报错信息落在任何可读的位置。所以这里
# 把可机检的几条钉住——它们覆盖的正是本次真实踩到的那一类错误。
#
# # 这个检查自己的盲区（必须说清，否则会造成虚假的安全感）
#
# 它**兜不住「本文件自身失效」**：文件无效时整个 workflow 不运行，
# 这个检查也就不会被执行。因此它真正的价值在两处：
#
# 1. **本地/CI 的其它入口**（`npm test` 会跑它）——提交前挡住；
# 2. **跨文件与跨 job**：本文件坏在 `rust` job 里、或新增了别的
#    workflow 文件时，仍会有别的 job 跑起来并抓住它。
#
# 兜住「本文件自身」的唯一可靠办法是**外部观测**：确认某次推送
# 真的产生了 job（而不是一个 0 job 的 run）。这需要一个带凭据的
# 外部检查，不在本脚本范围内——但它至少让「没跑」这件事可被看见。
#
# 用法：bash scripts/verify-workflow.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF_DIR="$ROOT/.github/workflows"

echo "════════ workflow 自校验 ════════"

if [[ ! -d "$WF_DIR" ]]; then
  echo "✗ 缺少 $WF_DIR" >&2
  exit 1
fi

FILES=$(find "$WF_DIR" -name '*.yml' -o -name '*.yaml' 2>/dev/null | sort)
if [[ -z "$FILES" ]]; then
  echo "✗ workflows 目录下没有 YAML 文件" >&2
  exit 1
fi

ERRORS=0
note() { echo "  ✗ $*" >&2; ERRORS=$((ERRORS + 1)); }

# 允许的行内豁免：在出问题的行上方或同行写 `# workflow-check: ignore <规则>`
ignored() { grep -q "workflow-check: ignore $2" <<<"$1"; }

# ── 1. `if:` 里不得出现 secrets ────────────────────────────────────────────
# 这是本次的根因。`secrets` 可用在 env / with / run，但**不可用在 if**
# （同一限制也适用于 `environment` 等其它上下文）；一旦出现，整个文件作废。
while IFS= read -r file; do
  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno + 1))
    # 只匹配真正的 `if:` 行（含 `if:` 后跟表达式）
    if [[ "$line" =~ ^[[:space:]]*if:.*secrets\. ]]; then
      ignored "$line" "secrets-in-if" && continue
      note "$(basename "$file"):$lineno secrets 出现在 if 表达式中 —— 会让整个 workflow 文件失效（改用 job 级 env 里的布尔标记）"
    fi
  done < "$file"
done <<< "$FILES"

# ── 2. `-p <crate>` 必须真的是 workspace 成员 ─────────────────────────────
# 无效的 crate 名会让该步骤失败，但更容易被忽略的是：步骤失败在「job 已经
# 跑起来」的噪音里，而这一步往往在很后面。本次就同时存在这个错误
# （写的是 `-p codex-bridge`，实际 crate 叫 `kcode-bridge`）。
#
# 注意 Cargo.toml 的 members 写的是**路径**（crates/kcode-bridge），
# 而 `cargo -p` 要的是**包名**——两者恰好同名，但不能据此假定相等，
# 所以逐个读成员的 Cargo.toml 取 `name`（改过目录名或包名时仍然正确）。
MEMBER_PATHS=$(sed -n '/^members/,/]/p' "$ROOT/Cargo.toml" | grep -oE '"[^"]+"' | tr -d '"')
MEMBERS=""
for m in $MEMBER_PATHS; do
  n=$(sed -n 's/^name[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$ROOT/$m/Cargo.toml" | head -1)
  # 找不到 name 就用目录名兜底，并提示
  if [[ -z "$n" ]]; then
    n=$(basename "$m")
    echo "  ! 无法从 $m/Cargo.toml 读出包名，暂用目录名 $n" >&2
  fi
  MEMBERS="$MEMBERS$n"$'\n'
done
while IFS= read -r file; do
  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno + 1))
    while read -r crate; do
      [[ -z "$crate" ]] && continue
      if ! grep -qx "$crate" <<<"$MEMBERS"; then
        note "$(basename "$file"):$lineno cargo -p $crate —— 不是 workspace 成员（成员：$(tr '\n' ' ' <<<"$MEMBERS"))"
      fi
    done < <(grep -oE '\-p [A-Za-z0-9_-]+' <<<"$line" | awk '{print $2}')
  done < "$file"
done <<< "$FILES"

# ── 3. run: 里引用的仓库内脚本必须存在 ─────────────────────────────────────
# 指向不存在的脚本会在 job 里失败；提前挡掉，省一轮往返。
while IFS= read -r file; do
  while read -r script; do
    [[ -z "$script" ]] && continue
    if [[ ! -f "$ROOT/$script" ]]; then
      note "$(basename "$file") 引用了不存在的脚本：$script"
    fi
  done < <(grep -oE 'scripts/[A-Za-z0-9_.-]+\.(sh|mjs)' "$file" | sort -u)
done <<< "$FILES"

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "✗ 发现 $ERRORS 处会让 CI 无效或失败的问题" >&2
  echo "  提示：workflow 无效时 GitHub 不会在任一步骤报错——它只创建一个 0 job 的 run。" >&2
  exit 1
fi

echo "  ✓ if 表达式中无 secrets"
echo "  ✓ cargo -p 的 crate 名均为 workspace 成员"
echo "  ✓ 引用的脚本文件都存在"
echo "✓ workflow 自校验通过"
