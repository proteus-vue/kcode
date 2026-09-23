# 测试统计

> 由 `scripts/test-stats.mjs` 自动生成，**请勿手工编辑**。
> 生成依据：当前工作区 + 锁定的 codex CLI **0.155.1**。
> 本文件的含义是「这些数字都实际跑通过」——任一环节失败时脚本不会生成文件。
> 比对漂移：`node scripts/test-stats.mjs --check`（CI 已接入）。

## 汇总

| 类别 | 数量 | 失败 | 状态 |
|---|---|---|---|
| Rust（`cargo test -p <crate>`，四个 crate） | 286 | 0 | ✅ 全部通过 |
| 前端（`vitest run`） | 546 | 0 | ✅ 全部通过 |
| 协议契约（真实 codex 二进制端到端） | 56 | 0 | ✅ 全部通过 |

Rust 按 crate 分布：kcode-bridge 75 / kcode-domain 116 / kcode-app 50 / kcode-desktop 45。
前端覆盖 41 个测试文件；Rust 另有 1 项被显式忽略（`#[ignore]` 或文档测试，不计入通过数）。

## Rust 明细

| crate | 测试目标 | 通过 | 失败 | 忽略 |
|---|---|---|---|---|
| `kcode-bridge` | src/lib.rs（单元测试） | 65 | 0 | 0 |
| `kcode-bridge` | tests/approval_semantics.rs | 4 | 0 | 0 |
| `kcode-bridge` | tests/contract.rs | 5 | 0 | 0 |
| `kcode-bridge` | 文档测试 | 1 | 0 | 1 |
| `kcode-domain` | src/lib.rs（单元测试） | 112 | 0 | 0 |
| `kcode-domain` | tests/integration.rs | 4 | 0 | 0 |
| `kcode-app` | src/lib.rs（单元测试） | 8 | 0 | 0 |
| `kcode-app` | tests/acceptance.rs | 12 | 0 | 0 |
| `kcode-app` | tests/e2e.rs | 20 | 0 | 0 |
| `kcode-app` | tests/wire_contract.rs | 10 | 0 | 0 |
| `kcode-desktop` | src/lib.rs（单元测试） | 45 | 0 | 0 |

## 协议契约明细

| 脚本 | 覆盖 | 断言 | 结果 |
|---|---|---|---|
| `contract-test.mjs` | 协议链路：握手 → 建线程 → 审批往返 → 收尾 | 22 | 22/22 通过 |
| `contract-settings.mjs` | 设置与配置：读写、覆盖作用域、隔离 | 22 | 22/22 通过 |
| `contract-workbench.mjs` | 工作台：命令执行、tty、边界 | 12 | 12/12 通过 |

## 复现

```bash
node scripts/test-stats.mjs          # 重新统计（会真的跑一遍全部测试）
cargo test --workspace               # 仅 Rust
npx vitest run                       # 仅前端
npm test                             # 版本校验 + 三个契约脚本 + 前端
```
