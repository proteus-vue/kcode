# Phase 1 验收报告

> 日期：2026-09-20 ｜ 环境：macOS 26.5 arm64，codex CLI **0.155.1**
> 方式：**全程离线、零凭据**（本地 mock provider 冒充模型）+
>       **出站连接实时抓取**
>
> **关于数字**：本文是当日状态快照，其中「112 项」「17 项」等测试数量是**当时实跑的结果**，
> 不代表当前值——后续开发已让它们变化。当前数量由 `scripts/test-stats.mjs` 实跑统计，
> 见 [`test-stats.md`](test-stats.md)；本文的数字**不随代码更新**，改动即失真，故保持原样。

---

## 0. 结论摘要

| 类别 | 结果 |
|---|---|
| 协议链路正确性 | ✅ 全部通过（自动） |
| 崩溃恢复 | ✅ 全部通过（自动） |
| 安全承诺 | ⚠️ **一条与预期不符，已如实披露**（见 §3） |
| 真实模型行为 | ⏸ **未执行**——本机无可用模型凭据（见 §5） |

**未执行的部分不标记为通过。** 本报告只记录实际跑过的验证。

---

## 1. 已验证项（自动，可复现）

运行方式：`cargo test --workspace`（112 项）、`npm test`（22 项契约 + 17 项前端）、
`bash scripts/verify-no-egress.sh`。

### 1.1 崩溃恢复

| 验收项 | 结果 | 证据 |
|---|---|---|
| `kill -9` 后 UI 收到 `ProcessExited` | ✅ | `crash_recovery_after_sigkill` |
| 活动轮次可判定为 unknown，**不静默当作成功** | ✅ | 同上 + `should_mark_unknown` 单测 |
| 崩溃后事件日志完整（历史不丢） | ✅ | 同上，直接读取 SQLite 校验事件种类 |
| 重启后线程历史**在用户界面可见** | ✅ | `threads_survive_restart_via_public_api` + GUI 实测 |

> **修正记录**：本报告早先把「重启后历史可重建」标记为通过，依据是
> `history_survives_restart`（直接读事件日志）。但那**只是后端能力**——
> `replay_items` 存在、有测试，而 Tauri 层从未暴露、前端从不调用。
> 用户实际重启应用看到的是**空侧栏**。
>
> 经 GUI 验收发现后已补齐：新增 `list_threads` / `load_thread` 两个
> Tauri 命令与前端启动加载逻辑，并加了 `threads_survive_restart_via_public_api`
> 测试走公开 API 验证这条用户路径。GUI 实测确认重启后侧栏正常显示。
>
> 教训：「可恢复」这类主张必须在**用户可见层面**验证。后端有能力不等于
> 用户能看到——把两者混为一谈是验收报告最容易犯的错误。
| 重放保留终态（不退回 inProgress） | ✅ | 同上 |

**方法说明**：用 `kill -9` 而非优雅关闭——前者让所有清理逻辑都来不及运行，
是唯一能验证「历史是否真的持久化」而非「靠内存侥幸存活」的方式。

### 1.2 审批链路

| 验收项 | 结果 | 证据 |
|---|---|---|
| 命令审批端到端（请求 → 决策 → 收尾） | ✅ | `full_approval_flow_through_service` |
| `decline` 后 Item 状态为 `declined` 且到达 UI | ✅ | `declined_item_reaches_ui_as_declined` |
| **`decline` 使命令完全不执行**（含沙箱内降级执行也排除） | ✅ | `approval_semantics.rs` 四条断言 |
| 非法决策值 fail-safe（不被当作批准） | ✅ | `unrecognized_decision_is_fail_safe` |
| 文件变更审批路径 | ✅ | `file_change_approval_path` |
| 被拒绝的文件变更与 completed 可区分 | ✅ | `declined_file_change_is_distinguishable` |
| 未知审批 id 报错而非静默成功 | ✅ | `unknown_approval_id_is_rejected` |

### 1.3 交互与并发

| 验收项 | 结果 | 证据 |
|---|---|---|
| 事件等待期间命令仍被服务（无死锁） | ✅ | `commands_are_serviced_while_events_are_pending` |
| 多轮对话累积且不互相覆盖 | ✅ | `multi_turn_conversation_accumulates` |
| 并发线程不串线 | ✅ | `concurrent_threads_do_not_cross_contaminate` |
| 长输出（>10k 行）完整送达 | ✅ | `long_output_is_delivered_intact`（实测 12000 行） |
| 越界路径被识别为高风险并记审计 | ✅ | `parent_directory_escape_is_flagged_and_audited` |

### 1.4 安全

| 验收项 | 结果 | 证据 |
|---|---|---|
| 审计日志不含明文凭据 | ✅ | `audit_does_not_leak_credentials`（10 项脱敏单测） |
| 默认沙箱为 `workspace-write` 而非 full-access | ✅ | `sandbox_defaults_are_restrictive` |
| 默认审批策略为 `on-request` | ✅ | 同上 |
| 拒绝以用户真实 `~/.codex` 启动 | ✅ | `refuses_spawn_with_real_user_codex_home` |
| 握手回传值校验（隔离失效即拒绝启动） | ✅ | `rejects_mismatched_codex_home` |

### 1.5 断言有效性（变异测试）

「测试通过」不等于「测试有效」。对关键断言做了变异验证——故意破坏实现，
确认测试**会失败**：

| 变异 | 预期 | 结果 |
|---|---|---|
| 移除 `ProcessExited` 广播 | 崩溃验收失败 | ✅ 失败（报「UI 会永远显示运行中」）|
| 审计写入不脱敏 | 凭据泄露检测失败 | ✅ 失败（报「脱敏未生效」）|
| `decline` 探针改发 `accept` | 拒绝语义测试失败 | ✅ 失败 |
| 非法决策改发 `accept` | fail-safe 测试失败 | ✅ 失败 |
| 移除 `exitCode` 的 camelCase 重命名 | 线格式测试失败 | ✅ 失败 |
| 移除 `CommandExecution` 的 `rename_all` | 线格式测试失败 | ✅ 失败 |

---

## 2. 验收中发现并修复的缺陷

| # | 缺陷 | 性质 | 发现方式 |
|---|---|---|---|
| 1 | 审计记录明文密钥 | **安全承诺未兑现**——`SECURITY.md` 声称「审计不含明文凭据」，但写入路径未脱敏 | 验收测试断言失败 |
| 2 | `mkfs.ext4` 漏判 | 风险分级漏报：磁盘操作被降为普通区外路径（High）而非严重（Critical） | 单元测试 |
| 3 | `ItemBody` / `AppEvent` / `RiskSignal` 字段未按 camelCase 序列化 | 前端读 `undefined`，且无编译错误 | 集成测试 + 新增线格式契约层 |
| 4 | 前端归约污染输入状态 | 浅拷贝共享数组被就地修改 | 「归约是纯函数」测试 |
| 5 | e2e mock 写了空切片 `&buf[x..x]` | 所有审批测试超时失败 | 诊断输出定位 |
| 6 | 验收 harness 的 `waitTurn` 引用未填充的数组 | 每个场景干等 5 分钟 | 实测耗时异常 |

第 1 项与第 3 项尤其值得记录：**它们都是「看起来已经做对了」的承诺**。
脱敏在前端已实现且有测试，但审计写入在后端——两处独立，只有端到端断言才能发现缺口。

---

## 3. ⚠️ 未达预期的安全发现（重要）

### 现象

`scripts/verify-no-egress.sh` 实时抓取 app-server 进程的网络连接，发现：

```
codex  <pid>  TCP [本机v6]:xxxxx->[2a03:2880:f117:83:face:b00c:0:25de]:443 (SYN_SENT)
```

### 查证过程

| 步骤 | 结论 |
|---|---|
| 反向 DNS | 无 PTR 记录 |
| 比对已知域名 | `api.openai.com` → `2a03:2880:f11f:...`；`chatgpt.com` → `2a03:2880:f112:...`。当日本判定为 OpenAI 的 CDN 段（Meta 托管）——**该判定已更正，见下方修正记录** |
| 启动即触发？ | 否。仅在 `thread/start` 期间发起 |
| 与模型名相关？ | 否。`kcode-mock-model` / `gpt-5.2` / `gpt-5.3-codex` 均触发 |
| 与自定义 provider 相关？ | 否。完全不配置 provider 时同样触发 |
| 可否用 feature flag 关闭？ | 否。`api_key_model_discovery` 默认已关闭且非来源；`in_app_updates`、`remote_plugin` 关闭后仍触发 |
| 连接是否建立？ | 否，始终停在 `SYN_SENT` |
| 是否有数据传输？ | 未观测到（连接未建立） |

### 判定

这是 **codex CLI 自身的行为，不是 KCode 引入的**。KCode 只是托管它的进程。

> **修正记录（归属错误）**：本节原先把观测到的地址判定为「OpenAI 的 CDN 段
> （`2a03:2880::/32`，Meta 托管）」。**这个归属是错的**：该地址的 PTR 是
> `edge-star-mini6-shv-01-tpe1.facebook.com`，属 Facebook 段；本机 DNS 对
> `api.openai.com` / `chatgpt.com` 的应答是**被污染的伪造地址**（每次查询都不同，
> 还出现过 Twitter 段），而 `cdn.openai.com` 实测指向 Azure Front Door。
> 「连接未建立、无数据传输」这一观测仍然成立，但**目标归属无法由地址推出**。
> 证据链与脚本的改正见 [`协议勘误与修正.md`](协议勘误与修正.md) §3.22。

它确实构成一次**用户未显式配置的出站尝试**，因此：

1. **不宣称「零出站」**——`SECURITY.md` 已新增专节如实披露，标注为上游行为、触发条件、可否关闭。
2. **让事实可见**：`verify-no-egress.sh` 把它**单独计数报告**而非静默忽略。
   任何**第三类**（既非本地 provider、也无法归属为上游元数据拉取）的连接都会导致脚本失败；
   归属依据（PTR / 等于本机 DNS 应答 / 兜底段）会打印出来，无法归属时需显式放行。
3. **提供规避路径**：文档说明可在防火墙/hosts 层阻断该元数据端点。

**未做的事**：没有把它包装成「预期行为」一笔带过。本项目的主张是
「你能验证我在做什么」——验证结果与预期不符时，正确做法是如实记录，
而不是调整措辞让报告好看。

---

## 4. 已知限制

| 限制 | 影响 | 现状 |
|---|---|---|
| 风险分级为字符串启发式 | 必然不完备（如别名调用、脚本包装的命令可能漏判） | 设计上只影响展示与排序，**不参与放行决策**；强制边界由沙箱承担 |
| Windows 沙箱为官方实验性 | 隔离强度不足 | `SECURITY.md` 已明示需叠加 Hyper-V/WSL/容器 |
| `hardlink`/符号链接逃逸未专门探测 | 分级器仅做路径规范化比较 | 同上，属分级层不完备，非强制边界缺陷 |
| 未做大规模压测 | 50+ 线程的侧栏性能未实测 | 验收清单项，缺口见 §5 |

---

## 5. 未执行项（如实记录）

### 5.1 真实模型验收 —— 阻塞于环境

**本机无可用模型凭据**，已逐一确认：

- `~/.codex/auth.json` 不存在
- `OPENAI_API_KEY` 等环境变量均未设置
- 配置中的 `experimental_bearer_token` 为 `"PROXY_MANAGED"` 占位符（由第三方代理工具管理），
  其指向的本地 relay（`127.0.0.1:15721`）**未运行**
- 无本地推理服务（8000/8080/11434/1234 无监听；5000 为 macOS AirPlay）

**处置**：提供 `scripts/acceptance-real-model.sh`，凭据就绪后一键执行。
该脚本已用真实 HTTP provider 端点验证过完整流程（建线程 → 三轮场景 → 结果汇总），
无凭据时**退出码 3 并打印配置指引**，不会伪造通过。

执行方式（三种凭据任选其一）：

```bash
codex login                                         # ChatGPT 登录
export OPENAI_API_KEY=sk-...                         # API key
export KCODE_MODEL_BASE_URL=... KCODE_MODEL_API_KEY=...  # 兼容 provider

bash scripts/acceptance-real-model.sh /path/to/workspace
```

**未验证的具体内容**（mock 无法覆盖）：

- 真实模型的推理内容与工具调用序列
- 真实 `apply_patch` 的完整落盘与审批交互
- 长任务的规划质量与多步执行
- 真实 token 用量与计费路径

**已覆盖的等价部分**：协议链路（消息格式、审批往返、状态流转）
不依赖模型真实性，已由 112 项测试完整验证。

### 5.2 其余未执行项

| 项 | 原因 |
|---|---|
| 50+ 线程侧栏性能 | 需构造大规模数据；`long_output` 已覆盖单线程长输出 |
| 真机 GUI 手工验收 | 需启动 Tauri 窗口人工操作 |
| 真实 git push / PR 流程 | 需远端仓库与凭据 |
| Worktree 并行合并 | 功能尚未实现 |

---

## 6. 复现方式

```bash
npm install
cargo test --workspace              # 112 项：协议、领域、编排、验收
npm test                            # 22 项协议契约 + 17 项前端
bash scripts/verify-no-egress.sh    # 出站连接实时抓取
```

全部离线、零凭据、不污染真实 `~/.codex`（`CODEX_HOME` 隔离 + 握手回传值校验）。
