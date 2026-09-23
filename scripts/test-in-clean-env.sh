#!/usr/bin/env bash
# 在「干净的 CI 环境」下跑测试：模拟 GitHub Actions runner 的差异。
#
# # 为什么需要
#
# 开发机（macOS）与 CI runner（ubuntu）的差异会**只在 CI 上**让测试失败，
# 而本地反复跑都是绿的。本项目实际踩到过：`commit_all_creates_commit`
# 依赖机器上存在全局 `user.name`（开发机总有，全新容器没有），
# 于是同一个测试在本地永远通过、在 CI 永远失败。
#
# 这类失败有个共同点：**测试隐式依赖了开发机上的既有配置**。
# 它不会在本地复现，所以「本地全绿」对 CI 的预测力为零。
# 本脚本把那些差异显式化，让它们在本地就能被看见。
#
# 覆盖的差异（都是实战中真实咬过的）：
#
# | 差异 | 模拟方式 | 曾造成的失败 |
# |---|---|---|
# | 无全局/系统 git 身份 | `GIT_CONFIG_GLOBAL=/dev/null` 等 | `commit_all_creates_commit` |
# | 无 `$HOME`（容器里未必有） | `env -u HOME` | 路径推导类测试 |
# | 无 KCODE_* 覆盖 | 清空这些变量 | 编辑器探测被开发机配置影响 |
#
# # 边界（如实说明）
#
# 它**不是** Linux 模拟器：平台相关的 `cfg(target_os)` 分支、glibc 与
# musl 的差异、大小写敏感的文件系统，这些在 macOS 上模拟不出来。
# 本脚本解决的是**环境依赖**那一类；平台差异仍只能靠 CI 发现。
#
# 用法：bash scripts/test-in-clean-env.sh          # 全部 crate
#       bash scripts/test-in-clean-env.sh --lib    # 只跑单元测试（同 CI 的 rust job）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ARGS=("test" "--workspace")
if [[ "${1:-}" == "--lib" ]]; then
  ARGS+=("--lib")
fi

# cargo 必须用**真实** HOME 定位：下面的 `env HOME=…` 只作用于被测进程，
# 不该影响我们找工具链（早先的写法先改了 HOME 再找 cargo，于是永远找不到
# ——本脚本自己的第一个 bug，被自己的首次运行抓到）。
CARGO="${CARGO:-cargo}"
if ! command -v "$CARGO" >/dev/null 2>&1; then
  for c in "$HOME/.cargo/bin/cargo" /usr/local/bin/cargo /opt/homebrew/bin/cargo; do
    [[ -x "$c" ]] && { CARGO="$c"; break; }
  done
fi
if ! command -v "$CARGO" >/dev/null 2>&1 && [[ ! -x "$CARGO" ]]; then
  echo "✗ 未找到 cargo（PATH 与常见安装路径都没有）" >&2
  exit 2
fi

echo "════════ 干净环境下的测试（模拟 CI runner）════════"
echo "  无全局/系统 git 身份、无 \$HOME、无 KCODE_* 变量"
echo ""

# 干净的 HOME：模拟 runner 上「有 HOME 但没有用户既有配置」的状态。
# 不直接删掉 HOME——那会让部分工具去读 /etc/passwd，行为反而偏离 CI。
CLEAN_HOME="$(mktemp -d)"
trap 'rm -rf "$CLEAN_HOME"' EXIT

# CARGO_HOME 与 target 目录刻意**保留**：它们是构建缓存，不是「用户配置」。
# 一起清掉会让本地每次全量重编译（数分钟），而 CI 上本来就有
# Swatinem/rust-cache 提供缓存——模拟缓存缺失不是本脚本的目的。
# 工具链目录**必须保留**：rustup 靠 `RUSTUP_HOME`（默认 ~/.rustup）与
# `CARGO_HOME` 定位 toolchain。它们属于「工具安装」，不是「用户配置」——
# 换掉它们会让 rustup 直接报 "could not choose a version of cargo to run"
# （本脚本的第二个自伤 bug，同样被首次运行抓到）。CI 上这两个变量也存在。
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME CARGO_HOME

# `env` 的参数顺序有要求：`-u` 必须在所有 `VAR=value` **之前**，
# 否则会被当成要执行的命令名（报 `env: -u: No such file or directory`）。
#
# 作者身份类变量（GIT_AUTHOR_NAME 等）用 **`-u` 删掉**，而不是设成空串：
# git 把「已设置但为空」与「未设置」区别对待——空值会**压过**仓库里的
# `user.name`，直接报 `fatal: empty ident name (for <>) not allowed`。
# 而 CI runner 上这些变量是**不存在**的，不是空的。设空串会把测试环境
# 变得比 CI 更严苛，制造出 CI 上不会发生的失败（本脚本的第三个自伤 bug，
# 由「本机复现出的失败与 CI 不同」暴露）。见 docs/协议勘误与修正.md §3.26。
env \
  -u KCODE_EDITOR -u KCODE_MODEL_BASE_URL -u KCODE_MODEL_API_KEY -u KCODE_MODEL_NAME \
  -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL \
  -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
  HOME="$CLEAN_HOME" \
  RUSTUP_HOME="$RUSTUP_HOME" \
  CARGO_HOME="$CARGO_HOME" \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_CONFIG_SYSTEM=/dev/null \
  "$CARGO" "${ARGS[@]}"
status=$?

if [[ $status -ne 0 ]]; then
  echo "" >&2
  echo "✗ 干净环境下有测试失败——这正是 CI 上会看到的失败。" >&2
  echo "  提示：多数时候根因是测试**隐式依赖了开发机上的既有配置**，" >&2
  echo "  应在测试夹具里显式构造该状态（例如把 git 身份写进仓库配置），" >&2
  echo "  而不是假定它已存在。见 docs/协议勘误与修正.md §3.26。" >&2
fi
exit $status
